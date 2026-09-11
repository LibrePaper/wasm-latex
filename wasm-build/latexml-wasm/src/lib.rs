//! Browser ABI for latexml-oxide.
//!
//! The host owns one Web Worker per module, so this crate deliberately calls
//! the converter on the worker's only thread. It does not use
//! `latexml::api::convert_to_html`, whose convenience API creates a native
//! 256 MiB worker thread and is unsuitable for an Emscripten worker.

use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    rc::Rc,
};

use latexml::{converter::Converter, post};
use latexml_core::common::{Config, OutputFormat};

const WORK_ROOT: &str = "/work";

struct State {
    files: BTreeMap<String, Vec<u8>>,
    main: String,
    output: Vec<u8>,
    diagnostics: Vec<u8>,
    status: u32,
}

impl Default for State {
    fn default() -> Self {
        Self {
            files: BTreeMap::new(),
            main: String::from("main.tex"),
            output: Vec::new(),
            diagnostics: Vec::new(),
            status: 0,
        }
    }
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn bytes_at<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    // SAFETY: every exported caller promises that `ptr..ptr+len` is a valid
    // readable UTF-8/byte slice for the duration of this call.
    unsafe { std::slice::from_raw_parts(ptr, len) }
}

fn text_at(ptr: *const u8, len: usize) -> String {
    String::from_utf8_lossy(bytes_at(ptr, len)).into_owned()
}

fn set_failure(state: &mut State, message: impl Into<String>) {
    state.status = 3;
    state.output.clear();
    state.diagnostics = message.into().into_bytes();
}

fn work_path(path: &str) -> Result<PathBuf, String> {
    let mut relative = PathBuf::new();
    for component in Path::new(path).components() {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => relative.push(part),
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                return Err(format!("unsafe work path: {path}"));
            }
        }
    }
    if relative.as_os_str().is_empty() {
        return Err(format!("empty work path: {path}"));
    }
    Ok(Path::new(WORK_ROOT).join(relative))
}

fn install_files(state: &State) -> Result<(), String> {
    fs::create_dir_all(WORK_ROOT).map_err(|e| format!("cannot create {WORK_ROOT}: {e}"))?;
    for (path, bytes) in &state.files {
        let destination = work_path(path)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        fs::write(destination, bytes).map_err(|e| format!("cannot write {path}: {e}"))?;
    }
    Ok(())
}

fn convert(state: &mut State, source: String) {
    state.output.clear();
    state.diagnostics.clear();
    state.status = 3;
    if let Err(error) = install_files(state) {
        set_failure(state, error);
        return;
    }

    let options = Config {
        verbosity: -1,
        format: OutputFormat::HTML5,
        // Keep the standard compiled package and contrib dispatchers explicit
        // in the embedding config. Converter::initialize_session installs the
        // same priority chain used by the upstream HTML API.
        bindings_dispatch: Some(Rc::new(latexml_package::dispatch)),
        extra_bindings_dispatch: Some(Rc::new(latexml_contrib::dispatch)),
        search_paths: Some(vec![WORK_ROOT.to_string(), "/texmf".to_string()]),
        ..Config::default()
    };
    let mut converter = Converter::from_config(options.clone());
    let main_path = match work_path(&state.main) {
        Ok(path) => path,
        Err(error) => {
            set_failure(state, error);
            drop(converter);

            return;
        }
    };
    let response = match converter.prepare_session(&options) {
        Ok(()) => {
            converter.convert_content_with_provenance(&main_path.display().to_string(), source)
        }
        Err(error) => {
            set_failure(state, format!("could not prepare converter: {error}"));
            drop(converter);

            return;
        }
    };

    let Some(xml) = response.result else {
        set_failure(state, response.log);

        return;
    };
    let post_options = post::PostOptions {
        pmml: true,
        cmml: false,
        keep_xmath: false,
        stylesheet: post::default_stylesheet(Some("html5")),
        destination: None,
        source_directory: Some(WORK_ROOT),
        site_directory: None,
        search_paths: &[],
        nodefaultresources: false,
        css_files: &[],
        js_files: &[],
        noinvisibletimes: false,
        plane1: true,
        hackplane1: false,
        mathtex: false,
        url_style: latexml_post::crossref::UrlStyle::File,
        navigationtoc: None,
        schemadocs: false,
        split: false,
        split_xpath: None,
        split_naming: None,
        xslt_parameters: &[],
        graphics_svg_threshold_kb: 0,
        graphicimages: false,
        timestamp: None,
        icon: None,
        whatsout: latexml_post::extract::Whatsout::Document,
    };
    let outcome = post::run_post_processing_logged(&xml, &post_options);
    let output = outcome.html.into_bytes();
    let diagnostics = [response.log.trim(), outcome.log.trim()]
        .into_iter()
        .filter(|log| !log.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .into_bytes();
    let status = outcome.status_code.max(response.status_code) as u32;
    // Persistent workers retain interned symbols and kernel definitions.
    // prepare_session resets per-document state; terminating the Web Worker
    // releases the engine. reset_thread_engine is only safe before thread exit.
    state.output = output;
    state.diagnostics = diagnostics;
    state.status = status;
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(len);
    let pointer = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    pointer
}

/// # Safety
/// `pointer` and `len` must be exactly what a previous [`alloc`] returned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(pointer: *mut u8, len: usize) {
    // SAFETY: guaranteed by this function's contract.
    drop(unsafe { Vec::from_raw_parts(pointer, 0, len) });
}

/// # Safety
/// `source` and `source_len` must describe readable UTF-8 bytes. `main` and
/// `main_len` must describe the UTF-8 path used for the source file.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn compile(
    source: *const u8,
    source_len: usize,
    main: *const u8,
    main_len: usize,
) {
    let source = text_at(source, source_len);
    let main = text_at(main, main_len);
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        state.main = if main.is_empty() {
            "main.tex".to_string()
        } else {
            main
        };
        convert(&mut state, source);
    });
}

/// # Safety
/// `path` and `body` describe valid buffers for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn add_file(
    path: *const u8,
    path_len: usize,
    body: *const u8,
    body_len: usize,
) {
    let path = text_at(path, path_len);
    let body = bytes_at(body, body_len).to_vec();
    STATE.with(|cell| {
        if work_path(&path).is_ok() {
            cell.borrow_mut().files.insert(path, body);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_files() {
    STATE.with(|cell| cell.borrow_mut().files.clear());
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn set_main(path: *const u8, len: usize) {
    STATE.with(|cell| cell.borrow_mut().main = text_at(path, len));
}

#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const u8 {
    STATE.with(|cell| cell.borrow().output.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn output_len() -> usize {
    STATE.with(|cell| cell.borrow().output.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn diagnostics_ptr() -> *const u8 {
    STATE.with(|cell| cell.borrow().diagnostics.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn diagnostics_len() -> usize {
    STATE.with(|cell| cell.borrow().diagnostics.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn status() -> u32 {
    STATE.with(|cell| cell.borrow().status)
}

// Emscripten's standalone executable link needs a Rust entry point. The
// browser worker invokes the exported ABI functions directly and never calls
// this function.
fn main() {}
