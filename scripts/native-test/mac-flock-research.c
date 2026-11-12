/* Research fixture only. Never bundle or load in the user setup application. */
#include <node_api.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <string.h>

static pthread_mutex_t guard = PTHREAD_MUTEX_INITIALIZER;
static int held_fd = -1;
static int uncertain = 0;
#ifdef CBTE_RESEARCH_FAULT_INJECT
static int fail_next_close = 0;
#endif
static napi_value answer(napi_env env, const char *s) { napi_value v; napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v); return v; }
static napi_value acquire(napi_env env, napi_callback_info info) {
    size_t argc = 1, length = 0; napi_value argv[1]; char path[PATH_MAX]; struct stat before, opened, after;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1
        || napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &length) != napi_ok
        || length == 0 || length >= sizeof(path) - 1 || path[0] != '/' || strlen(path) != length) return answer(env, "INVALID");
    pthread_mutex_lock(&guard);
    if (uncertain) { pthread_mutex_unlock(&guard); return answer(env, "INVALID"); }
    if (held_fd != -1) { pthread_mutex_unlock(&guard); return answer(env, "BUSY"); }
    if (lstat(path, &before) || !S_ISREG(before.st_mode) || before.st_uid != getuid() || before.st_nlink != 1
        || (before.st_mode & 0777) != 0600) { pthread_mutex_unlock(&guard); return answer(env, "INVALID"); }
    int fd = open(path, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &opened) || !S_ISREG(opened.st_mode) || opened.st_uid != getuid() || opened.st_nlink != 1
        || (opened.st_mode & 0777) != 0600 || opened.st_dev != before.st_dev || opened.st_ino != before.st_ino) {
        if (fd >= 0 && close(fd)) uncertain = 1; pthread_mutex_unlock(&guard); return answer(env, "INVALID");
    }
    if (flock(fd, LOCK_EX | LOCK_NB)) {
        int e = errno, failed = close(fd); if (failed) uncertain = 1;
        pthread_mutex_unlock(&guard); return answer(env, !failed && (e == EWOULDBLOCK || e == EAGAIN) ? "BUSY" : "INVALID");
    }
    if (lstat(path, &after) || !S_ISREG(after.st_mode) || after.st_uid != getuid() || after.st_nlink != 1
        || after.st_dev != opened.st_dev || after.st_ino != opened.st_ino || (after.st_mode & 0777) != 0600) {
        if (close(fd)) uncertain = 1; pthread_mutex_unlock(&guard); return answer(env, "INVALID");
    }
    held_fd = fd; pthread_mutex_unlock(&guard); return answer(env, "OK");
}
static napi_value release(napi_env env, napi_callback_info info) {
    (void)info; pthread_mutex_lock(&guard); if (held_fd < 0) { pthread_mutex_unlock(&guard); return answer(env, "INVALID"); }
    int fd = held_fd; held_fd = -1; int result;
#ifdef CBTE_RESEARCH_FAULT_INJECT
    if (fail_next_close) { fail_next_close = 0; errno = EIO; result = -1; }
    else
#endif
    result = close(fd);
    if (result) uncertain = 1;
    pthread_mutex_unlock(&guard); return answer(env, result ? "INVALID" : "OK");
}
#ifdef CBTE_RESEARCH_FAULT_INJECT
static napi_value fail_close(napi_env env, napi_callback_info info) {
    (void)info; pthread_mutex_lock(&guard); fail_next_close = 1; pthread_mutex_unlock(&guard); return answer(env, "OK");
}
#endif
static napi_value inspect(napi_env env, napi_callback_info info) {
    (void)info; pthread_mutex_lock(&guard); int flags = held_fd < 0 ? -1 : fcntl(held_fd, F_GETFD);
    int fd = held_fd, uncertain_copy = uncertain; pthread_mutex_unlock(&guard); napi_value out, value; napi_create_object(env, &out);
    napi_get_boolean(env, flags >= 0 && (flags & FD_CLOEXEC), &value); napi_set_named_property(env, out, "cloexec", value);
    /* Exposed solely to check synthetic subprocess inheritance. */
    napi_create_int32(env, fd, &value); napi_set_named_property(env, out, "fixtureFd", value);
    napi_get_boolean(env, uncertain_copy, &value); napi_set_named_property(env, out, "uncertain", value); return out;
}
NAPI_MODULE_INIT() {
    napi_value fn; napi_create_function(env, "acquire", NAPI_AUTO_LENGTH, acquire, NULL, &fn); napi_set_named_property(env, exports, "acquire", fn);
    napi_create_function(env, "release", NAPI_AUTO_LENGTH, release, NULL, &fn); napi_set_named_property(env, exports, "release", fn);
    napi_create_function(env, "inspect", NAPI_AUTO_LENGTH, inspect, NULL, &fn); napi_set_named_property(env, exports, "inspect", fn);
#ifdef CBTE_RESEARCH_FAULT_INJECT
    napi_create_function(env, "failClose", NAPI_AUTO_LENGTH, fail_close, NULL, &fn); napi_set_named_property(env, exports, "failClose", fn);
#endif
    return exports;
}
