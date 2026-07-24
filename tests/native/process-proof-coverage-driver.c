#include <errno.h>
#include <libproc.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/types.h>

static int fake_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size);
static int fake_proc_pidpath(int pid, void *buffer, uint32_t size);
static char *fake_realpath(const char *path, char *resolved);
static int fake_fputs(const char *text, FILE *stream);
static int fake_putchar(int character);
static int fake_printf(const char *format, ...);
static int fake_fflush(FILE *stream);

#define OURO_PROC_PIDINFO fake_proc_pidinfo
#define OURO_PROC_PIDPATH fake_proc_pidpath
#define OURO_REALPATH fake_realpath
#define OURO_FPUTS fake_fputs
#define OURO_PUTCHAR fake_putchar
#define OURO_PRINTF fake_printf
#define OURO_FFLUSH fake_fflush
#define main process_proof_helper_main
#include "../../native/process-proof/process-proof-darwin.c"
#undef main

static struct proc_bsdinfo fake_info;
static int fake_info_result;
static const char *fake_path;
static int fake_path_result;
static int fake_realpath_available;
static int output_call_count;
static int fail_output_call;

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static void reset_fakes(void) {
  memset(&fake_info, 0, sizeof(fake_info));
  fake_info.pbi_uid = 501;
  fake_info.pbi_start_tvsec = 1770000000;
  fake_info.pbi_start_tvusec = 123;
  fake_info_result = (int)sizeof(fake_info);
  fake_path = "/usr/local/bin/runtime";
  fake_path_result = (int)strlen(fake_path);
  fake_realpath_available = 1;
  output_call_count = 0;
  fail_output_call = 0;
}

static int should_fail_output(void) {
  output_call_count += 1;
  return fail_output_call == output_call_count;
}

static int fake_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  (void)pid;
  (void)flavor;
  (void)arg;
  if (size >= (int)sizeof(fake_info)) memcpy(buffer, &fake_info, sizeof(fake_info));
  return fake_info_result;
}

static int fake_proc_pidpath(int pid, void *buffer, uint32_t size) {
  (void)pid;
  if (fake_path_result > 0 && (uint32_t)fake_path_result < size) {
    memcpy(buffer, fake_path, (size_t)fake_path_result);
  }
  return fake_path_result;
}

static char *fake_realpath(const char *path, char *resolved) {
  (void)path;
  if (!fake_realpath_available) return NULL;
  strcpy(resolved, fake_path);
  return resolved;
}

static int fake_fputs(const char *text, FILE *stream) {
  (void)text;
  (void)stream;
  return should_fail_output() ? EOF : 1;
}

static int fake_putchar(int character) {
  return should_fail_output() ? EOF : character;
}

static int fake_printf(const char *format, ...) {
  (void)format;
  return should_fail_output() ? -1 : 1;
}

static int fake_fflush(FILE *stream) {
  (void)stream;
  return should_fail_output() ? EOF : 0;
}

static int test_parse_pid(void) {
  pid_t pid = 0;
  CHECK(!parse_pid(NULL, &pid));
  CHECK(!parse_pid("", &pid));
  CHECK(!parse_pid("0", &pid));
  CHECK(!parse_pid("01", &pid));
  CHECK(!parse_pid("/", &pid));
  CHECK(!parse_pid("a", &pid));
  CHECK(!parse_pid("1a", &pid));
  CHECK(!parse_pid("99999999999999999999999999999999999999", &pid));
  CHECK(!parse_pid("2147483648", &pid));
  CHECK(parse_pid("42", &pid));
  CHECK(pid == 42);
  return 0;
}

static int test_json_output(void) {
  reset_fakes();
  CHECK(write_json_string("a\"\\\001"));
  reset_fakes();
  fail_output_call = 1;
  CHECK(!write_json_string("\""));
  reset_fakes();
  fail_output_call = 2;
  CHECK(!write_json_string("\""));
  reset_fakes();
  fail_output_call = 1;
  CHECK(!write_json_string("\001"));
  reset_fakes();
  fail_output_call = 1;
  CHECK(!write_json_string("a"));
  return 0;
}

static int test_emit_proof(void) {
  reset_fakes();
  CHECK(emit_proof(42));

  reset_fakes();
  fake_info_result = 0;
  CHECK(!emit_proof(42));
  reset_fakes();
  fake_info.pbi_start_tvusec = 1000000;
  CHECK(!emit_proof(42));
  reset_fakes();
  fake_path_result = 0;
  CHECK(!emit_proof(42));
  reset_fakes();
  fake_path_result = PROC_PIDPATHINFO_MAXSIZE;
  CHECK(!emit_proof(42));
  reset_fakes();
  fake_realpath_available = 0;
  CHECK(!emit_proof(42));

  for (int ordinal = 1; ordinal <= 4; ordinal += 1) {
    reset_fakes();
    fake_path = "a";
    fake_path_result = 1;
    fail_output_call = ordinal;
    CHECK(!emit_proof(42));
  }
  return 0;
}

static int test_helper_main(void) {
  char *valid[] = { "process-proof-darwin", "--pid", "42", NULL };
  char *bad_mode[] = { "process-proof-darwin", "--other", "42", NULL };
  char *bad_pid[] = { "process-proof-darwin", "--pid", "bad", NULL };
  char *short_argv[] = { "process-proof-darwin", NULL };

  reset_fakes();
  CHECK(process_proof_helper_main(1, short_argv) == EXIT_USAGE);
  reset_fakes();
  CHECK(process_proof_helper_main(3, bad_mode) == EXIT_USAGE);
  reset_fakes();
  CHECK(process_proof_helper_main(3, bad_pid) == EXIT_USAGE);
  reset_fakes();
  fake_info_result = 0;
  CHECK(process_proof_helper_main(3, valid) == EXIT_UNAVAILABLE);
  reset_fakes();
  CHECK(process_proof_helper_main(3, valid) == 0);
  return 0;
}

int main(void) {
  int result = test_parse_pid();
  if (result != 0) return result;
  result = test_json_output();
  if (result != 0) return result;
  result = test_emit_proof();
  if (result != 0) return result;
  return test_helper_main();
}
