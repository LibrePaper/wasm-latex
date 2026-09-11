fn main() {
    println!("cargo:rerun-if-changed=latexml-kpse-hook.c");
    cc::Build::new()
        .file("latexml-kpse-hook.c")
        .compile("latexml-kpse-hook");
}
