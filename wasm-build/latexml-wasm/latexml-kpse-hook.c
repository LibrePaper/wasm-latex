/* Keep the Rust kpathsea crate's normal API while routing misses into the
 * browser bundle resolver. The callback is synchronous because the converter
 * is running inside one dedicated Web Worker. */

/* kpathsea_sys exposes the in-process API as
 * kpathsea_find_file(kpathsea, const_string, kpse_file_format_type, boolean).
 * Keep the first argument opaque here: the wrapper only forwards it, and this
 * avoids coupling the small Rust build crate to generated bindgen headers. */
typedef struct kpathsea_instance *kpathsea;

extern char *__real_kpathsea_find_file(kpathsea kpse, const char *name,
                                       unsigned int format, int must_exist);
extern char *kpse_find_file_js(const char *name, unsigned int format,
                               int must_exist);

char *__wrap_kpathsea_find_file(kpathsea kpse, const char *name,
                                unsigned int format, int must_exist) {
  char *local = __real_kpathsea_find_file(kpse, name, format, 0);
  if (local != 0) return local;
  return kpse_find_file_js(name, format, must_exist);
}
