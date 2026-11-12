/* Unpublished research fixture. Not loaded by the setup application. */
#include <node_api.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

typedef struct { int active; } environment;
static pthread_mutex_t guard = PTHREAD_MUTEX_INITIALIZER;
static environment *owner = NULL;
static int lock_fd = -1, dir_fd = -1, poisoned = 0;
static struct stat lock_identity, dir_identity;
static char dir_name[PATH_MAX];
static napi_value result(napi_env env, const char *s) { napi_value v; napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v); return v; }
static int same(struct stat *a, struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
static int valid_dir(struct stat *s) { return S_ISDIR(s->st_mode) && s->st_uid == getuid() && (s->st_mode & 0777) == 0700; }
static int valid_lock(struct stat *s) { return S_ISREG(s->st_mode) && s->st_uid == getuid() && s->st_nlink == 1 && (s->st_mode & 0777) == 0600; }
static int verify_identity(void) {
    struct stat dir_now, named_dir, file_now, named_file; char resolved[PATH_MAX];
    return dir_fd >= 0 && lock_fd >= 0 && !fstat(dir_fd, &dir_now) && !lstat(dir_name, &named_dir)
        && valid_dir(&dir_now) && valid_dir(&named_dir) && same(&dir_now, &dir_identity) && same(&named_dir, &dir_identity)
        && realpath(dir_name, resolved) && !strcmp(dir_name, resolved)
        && !fstat(lock_fd, &file_now) && !fstatat(dir_fd, "session.lock", &named_file, AT_SYMLINK_NOFOLLOW)
        && valid_lock(&file_now) && valid_lock(&named_file) && same(&file_now, &lock_identity) && same(&named_file, &lock_identity);
}
static void finish(void) {
    int f = lock_fd, d = dir_fd; lock_fd = -1; dir_fd = -1; owner = NULL;
    if ((f >= 0 && close(f)) | (d >= 0 && close(d))) poisoned = 1;
}
static void cleanup(void *p) {
    environment *state = p; pthread_mutex_lock(&guard);
    if (owner == state) {
        if (state->active || poisoned) { poisoned = 1; owner = NULL; } /* retain descriptors until process exit */
        else finish();
    }
    pthread_mutex_unlock(&guard); free(state);
}
static environment *context(napi_env env, napi_callback_info info, size_t *argc, napi_value *args) {
    void *data = NULL; if (napi_get_cb_info(env, info, argc, args, NULL, &data) != napi_ok) return NULL; return data;
}
static napi_value acquire(napi_env env, napi_callback_info info) {
    size_t argc = 1, length = 0; napi_value args[1]; char path[PATH_MAX], resolved[PATH_MAX];
    environment *state = context(env, info, &argc, args);
    if (!state || argc != 1 || napi_get_value_string_utf8(env, args[0], path, sizeof(path), &length) != napi_ok
        || !length || length >= sizeof(path) - 1 || path[0] != '/' || strlen(path) != length || !realpath(path, resolved)
        || strcmp(path, resolved)) return result(env, "INVALID");
    pthread_mutex_lock(&guard);
    if (poisoned || lock_fd >= 0) { const char *r = poisoned ? "INVALID" : "BUSY"; pthread_mutex_unlock(&guard); return result(env, r); }
    struct stat named_dir, named_file; int d = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), f = -1;
    if (d < 0 || fstat(d, &dir_identity) || lstat(path, &named_dir) || !valid_dir(&dir_identity) || !valid_dir(&named_dir)
        || !same(&dir_identity, &named_dir)) goto invalid;
    f = openat(d, "session.lock", O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (f < 0 || fstat(f, &lock_identity) || fstatat(d, "session.lock", &named_file, AT_SYMLINK_NOFOLLOW)
        || !valid_lock(&lock_identity) || !valid_lock(&named_file) || !same(&lock_identity, &named_file)) goto invalid;
    if (flock(f, LOCK_EX | LOCK_NB)) { int busy = errno == EWOULDBLOCK || errno == EAGAIN;
        if (close(f) | close(d)) poisoned = 1;
        pthread_mutex_unlock(&guard); return result(env, busy && !poisoned ? "BUSY" : "INVALID"); }
    lock_fd = f; dir_fd = d; owner = state; memcpy(dir_name, path, length + 1);
    if (!verify_identity()) { poisoned = 1; finish(); pthread_mutex_unlock(&guard); return result(env, "INVALID"); }
    pthread_mutex_unlock(&guard); return result(env, "OK");
invalid:
    if ((f >= 0 && close(f)) | (d >= 0 && close(d))) poisoned = 1;
    pthread_mutex_unlock(&guard); return result(env, "INVALID");
}
static napi_value begin(napi_env env, napi_callback_info info) {
    size_t argc = 0; environment *state = context(env, info, &argc, NULL); pthread_mutex_lock(&guard);
    if (!state || state != owner || poisoned || !verify_identity()) { if (state == owner) poisoned = 1; pthread_mutex_unlock(&guard); return result(env, "INVALID"); }
    if (state->active) { pthread_mutex_unlock(&guard); return result(env, "BUSY"); }
    state->active = 1; pthread_mutex_unlock(&guard); return result(env, "OK");
}
static napi_value end(napi_env env, napi_callback_info info) {
    size_t argc = 0; environment *state = context(env, info, &argc, NULL); pthread_mutex_lock(&guard);
    if (!state || state != owner || poisoned || !state->active || !verify_identity()) { if (state == owner) poisoned = 1; pthread_mutex_unlock(&guard); return result(env, "INVALID"); }
    state->active = 0; pthread_mutex_unlock(&guard); return result(env, "OK");
}
static napi_value release(napi_env env, napi_callback_info info) {
    size_t argc = 0; environment *state = context(env, info, &argc, NULL); pthread_mutex_lock(&guard);
    if (!state || state != owner || poisoned || !verify_identity()) { if (state == owner) poisoned = 1; pthread_mutex_unlock(&guard); return result(env, "INVALID"); }
    if (state->active) { pthread_mutex_unlock(&guard); return result(env, "BUSY"); }
    finish(); const char *r = poisoned ? "INVALID" : "OK"; pthread_mutex_unlock(&guard); return result(env, r);
}
static napi_value status(napi_env env, napi_callback_info info) {
    size_t argc = 0; environment *state = context(env, info, &argc, NULL); pthread_mutex_lock(&guard);
    const char *r = poisoned ? "INVALID" : lock_fd < 0 ? "NONE" : state == owner ? "HELD" : "BUSY";
    pthread_mutex_unlock(&guard); return result(env, r);
}
NAPI_MODULE_INIT() {
    environment *state = calloc(1, sizeof(*state)); if (!state) return NULL;
    if (napi_add_env_cleanup_hook(env, cleanup, state) != napi_ok) { free(state); return NULL; }
    napi_value fn;
    napi_create_function(env, "acquire", NAPI_AUTO_LENGTH, acquire, state, &fn); napi_set_named_property(env, exports, "acquire", fn);
    napi_create_function(env, "begin", NAPI_AUTO_LENGTH, begin, state, &fn); napi_set_named_property(env, exports, "begin", fn);
    napi_create_function(env, "end", NAPI_AUTO_LENGTH, end, state, &fn); napi_set_named_property(env, exports, "end", fn);
    napi_create_function(env, "release", NAPI_AUTO_LENGTH, release, state, &fn); napi_set_named_property(env, exports, "release", fn);
    napi_create_function(env, "status", NAPI_AUTO_LENGTH, status, state, &fn); napi_set_named_property(env, exports, "status", fn);
    return exports;
}
