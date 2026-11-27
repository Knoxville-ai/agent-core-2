/*
 * knox_prctl.node — a minimal Node-API addon exposing two prctl(2) switches
 * that Node has no built-in for. Built in its own Docker stage (see the
 * Dockerfile) and loaded by src/openclaw/process-hardening.ts.
 *
 *   setNonDumpable()  prctl(PR_SET_DUMPABLE, 0)
 *       The process stops being "dumpable": /proc/<pid>/environ, /mem, /maps,
 *       /fd... become root-owned and ptrace attach is refused, so another
 *       process running under the same uid can no longer read this process's
 *       environment or memory. The kernel resets the flag on execve, so every
 *       long-lived process that holds secrets must call it itself.
 *
 *   setNoNewPrivs()   prctl(PR_SET_NO_NEW_PRIVS, 1)
 *       execve can no longer grant privileges (setuid/setgid bits, file
 *       capabilities). Inherited by every descendant and cannot be undone.
 *
 * Each setter returns 0 on success or the errno. The getters return the
 * current value (or -1).
 */
#include <errno.h>
#include <node_api.h>
#include <sys/prctl.h>

static napi_value int_result(napi_env env, int value) {
  napi_value out;
  if (napi_create_int32(env, value, &out) != napi_ok) return NULL;
  return out;
}

static napi_value set_non_dumpable(napi_env env, napi_callback_info info) {
  (void)info;
  return int_result(env, prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) == 0 ? 0 : errno);
}

static napi_value get_dumpable(napi_env env, napi_callback_info info) {
  (void)info;
  return int_result(env, prctl(PR_GET_DUMPABLE, 0, 0, 0, 0));
}

static napi_value set_no_new_privs(napi_env env, napi_callback_info info) {
  (void)info;
  return int_result(env, prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 ? 0 : errno);
}

static napi_value get_no_new_privs(napi_env env, napi_callback_info info) {
  (void)info;
  return int_result(env, prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
}

static int export_fn(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn) != napi_ok) return 0;
  return napi_set_named_property(env, exports, name, fn) == napi_ok;
}

NAPI_MODULE_INIT() {
  if (!export_fn(env, exports, "setNonDumpable", set_non_dumpable)) return NULL;
  if (!export_fn(env, exports, "getDumpable", get_dumpable)) return NULL;
  if (!export_fn(env, exports, "setNoNewPrivs", set_no_new_privs)) return NULL;
  if (!export_fn(env, exports, "getNoNewPrivs", get_no_new_privs)) return NULL;
  return exports;
}
