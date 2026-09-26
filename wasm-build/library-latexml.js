// Emscripten import used by latexml-kpse-hook.c. The authored worker defines
// kpse_find_file_impl after the Module has initialized, before conversion.
mergeInto(LibraryManager.library, {
  kpse_find_file_js: function(nameptr, format, mustexist) {
    return self.kpse_find_file_impl(nameptr, format, mustexist);
  },
  kpse_find_file_js__sig: 'iiii'
});
