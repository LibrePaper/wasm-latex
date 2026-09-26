// The mirror's Worker entry point: serve the precompressed brotli sidecar
// tools/mirror-brotli.mjs wrote, and otherwise get out of the way.
//
// Why a Worker at all, rather than a header rule on a static asset:
//
//   * Cloudflare compresses these responses on the fly already, but at a low
//     brotli quality. For the mirror's largest file that is 5.81 MB where a
//     quality-11 compression of the same bytes is 4.21 MB. The only way to
//     serve the better one is to have compressed it ahead of time and hand
//     the edge the finished bytes.
//
//   * Static assets alone cannot do that: a `.br` file is served as its own
//     opaque octet-stream, and `_headers` cannot turn it into a representation
//     of its neighbour.
//
// Why it serves brotli unconditionally rather than negotiating: Cloudflare
// rewrites the request's `Accept-Encoding` to a constant `"br, gzip"` before
// the Worker ever sees it, whatever the client actually sent (verified
// against a local `wrangler dev`: a client sending `Accept-Encoding: identity`
// still reaches the Worker as `br, gzip`). Negotiation is the edge's job, not
// ours -- that normalization is precisely so the edge can hold one
// representation and transcode it per client. We return the encoded
// representation and let it do that.
//
// `run_worker_first` in wrangler.jsonc is what gets this code in front of a
// request for a file that exists as a static asset; without it the asset
// server answers first and the sidecar is never consulted.

/// Requests this Worker must not rewrite, regardless of any sidecar present:
/// a range request has to be answered from the identity representation (byte
/// offsets into a brotli stream are meaningless), and the sidecars are
/// themselves fetchable by name.
function passThrough(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return true
  if (request.headers.has('Range')) return true
  return url.pathname.endsWith('.br')
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (passThrough(request, url)) return env.ASSETS.fetch(request)

    const sidecar = new URL(url)
    sidecar.pathname += '.br'
    const encoded = await env.ASSETS.fetch(new Request(sidecar, { method: 'GET' }))
    if (!encoded.ok) {
      if (encoded.body) await encoded.body.cancel()
      return env.ASSETS.fetch(request)
    }

    // Headers come from the file being represented, not from the sidecar:
    // Content-Type, and whatever Cache-Control and CORS the mirror's
    // `_headers` assigns it, must be the ones a client would have got for
    // the plain asset. Only the encoding-specific ones are replaced.
    const plain = await env.ASSETS.fetch(new Request(url, { method: 'HEAD' }))
    if (!plain.ok) {
      if (encoded.body) await encoded.body.cancel()
      return env.ASSETS.fetch(request)
    }
    const headers = new Headers(plain.headers)
    headers.set('Content-Encoding', 'br')
    // Two representations of one URL: say so, even though Cloudflare's cache
    // keys encodings itself, so that any cache in between keeps them apart.
    headers.set('Vary', 'Accept-Encoding')
    // The body is a different octet sequence from the identity one, so it
    // cannot answer to the identity entity tag. The sidecar's own tag is
    // already distinct; fall back to weakening the plain one.
    const tag = encoded.headers.get('ETag') || plain.headers.get('ETag')
    if (tag) headers.set('ETag', tag.startsWith('W/') ? tag : `W/${tag}`)
    else headers.delete('ETag')
    // Length belongs to the encoded body, and it is known: the sidecar is a
    // static file the asset server already sized. encodeBody below tells the
    // runtime that these bytes have already been compressed.
    const length = encoded.headers.get('Content-Length')
    if (length) headers.set('Content-Length', length)
    else headers.delete('Content-Length')

    if (request.method === 'HEAD') {
      if (encoded.body) await encoded.body.cancel()
      return new Response(null, { status: 200, headers, encodeBody: 'manual' })
    }
    return new Response(encoded.body, { status: 200, headers, encodeBody: 'manual' })
  },
}
