#ifndef FIXTURE_PROC_INFO_H
#define FIXTURE_PROC_INFO_H
#include <stdint.h>
#include <sys/types.h>
#define PROC_PIDTBSDINFO 3
struct proc_bsdinfo { uint32_t pbi_pid; uint32_t pbi_ppid; uid_t pbi_uid; uint64_t pbi_start_tvsec; uint64_t pbi_start_tvusec; };
#endif
