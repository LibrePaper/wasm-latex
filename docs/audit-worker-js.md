# What the workers can reach

The seven `wasm-build/*-worker.js` files and their four Emscripten glue files
are hand-written JavaScript we distribute and run in the browser. Two properties
matter for anything served from them, and neither is visible without reading all
4 154 lines, so they are recorded here with the commands that recheck them.

## No dynamic code

No `eval`, `new Function`, string `setTimeout`, or dynamic `import()` anywhere.
`importScripts` loads only files from our own dist directory — the Emscripten
module, the kpse resolver, the resolver-evidence helper.

    grep -nE '\beval\(|new Function|Function\(|import\(' wasm-build/*.js wasm-build/*.cjs
    grep -n 'importScripts' wasm-build/*.js

## No embedded endpoint

Every network call is a synchronous `XMLHttpRequest` — required by the
on-demand kpathsea model, which blocks inside the engine — and every URL is
built the same way:

    self.texlive_endpoint + "pdftex/" + format + "/" + name

`texlive_endpoint` is set only by the host, through the `settexliveurl`
command. There is no hard-coded hostname and no fallback URL, so the host
decides what the workers may talk to; nothing in these files can send a
recipient anywhere on its own.

    grep -nE 'https?://' wasm-build/*.js          # expect no matches
    grep -n 'texlive_endpoint' wasm-build/*.js

Traffic is read-only file fetches, with no credentials and no cookies.
`postMessage` carries compiled output (PDF, XDV, format, logs), cache
manifests, and resolver evidence — the last truncated to eight attempts and
512 characters per name. Project file contents move only on an explicit
`readfile`/`writefile` from the host.

## If either property changes

They are the reason the workers can be published without auditing the host's
network policy at the same time. A hard-coded URL or an `eval` in this layer
would have to be justified in `THIRD_PARTY_NOTICES.md` terms, not just reviewed
— it changes what a recipient of the binaries is exposed to.
