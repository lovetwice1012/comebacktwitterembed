/*
 * Lock one or two existing LevelDB LOCK files for a dedicated setup profile.
 * The parent verifies profile ownership and paths before starting this helper.
 * No file content is read, modified, created or sent over a network.
 * stdout: R = all locks held, B = another process holds a lock, E = error.
 * Locks are released when stdin closes or one byte is received.
 */
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>

static int lock_existing(const char *name) {
    struct stat st;
    struct flock lock;
    if (!name || name[0] != '/' || strlen(name) > 4096) return -1;
    int fd = open(name, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid() || st.st_nlink != 1) {
        close(fd); return -1;
    }
    memset(&lock, 0, sizeof(lock));
    lock.l_type = F_WRLCK;
    lock.l_whence = SEEK_SET;
    if (fcntl(fd, F_SETLK, &lock) < 0) {
        int busy = errno == EACCES || errno == EAGAIN;
        close(fd); return busy ? -2 : -1;
    }
    return fd;
}

int main(int argc, char **argv) {
    if ((argc != 2 && argc != 3) || (argc == 3 && !strcmp(argv[1], argv[2]))) { (void)write(STDOUT_FILENO, "E", 1); return 2; }
    int first = lock_existing(argv[1]);
    if (first < 0) { (void)write(STDOUT_FILENO, first == -2 ? "B" : "E", 1); return 2; }
    int second = -1;
    if (argc == 3) {
        second = lock_existing(argv[2]);
        if (second < 0) { close(first); (void)write(STDOUT_FILENO, second == -2 ? "B" : "E", 1); return 2; }
        struct stat first_stat, second_stat;
        if (fstat(first, &first_stat) || fstat(second, &second_stat)
            || (first_stat.st_dev == second_stat.st_dev && first_stat.st_ino == second_stat.st_ino)) {
            close(second); close(first); (void)write(STDOUT_FILENO, "E", 1); return 2;
        }
    }
    if (write(STDOUT_FILENO, "R", 1) == 1) {
        char byte;
        ssize_t count;
        do { count = read(STDIN_FILENO, &byte, 1); } while (count < 0 && errno == EINTR);
    }
    if (second >= 0) close(second);
    close(first);
    return 0;
}
