#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

#define REQUIRED_FIELDS 4U
#define PLAN_FIELDS 6U
#define MAXIMUM_FIELD_BYTES 1048576U
#define MAXIMUM_FRAME_BYTES (4U + REQUIRED_FIELDS * (4U + MAXIMUM_FIELD_BYTES))
#define PLAN_PATH "developer-id-pair-canary-native-plan.v1.bin"
#define CANARY_PATH "developer-id-pair-canary-input"
#define SIGNING_IDENTIFIER "bot.ouro.pair-canary"

typedef struct {
  unsigned char *bytes;
  size_t length;
} byte_field;

typedef struct {
  unsigned char *storage;
  size_t storage_length;
  byte_field fields[PLAN_FIELDS];
} public_plan;

typedef struct __SecCodeSigner *SecCodeSignerRef;
extern const CFStringRef kSecCodeSignerIdentifier;
extern const CFStringRef kSecCodeSignerIdentity;
extern OSStatus SecCodeSignerCreate(CFDictionaryRef parameters, SecCSFlags flags, SecCodeSignerRef *signer);
extern OSStatus SecCodeSignerAddSignature(SecCodeSignerRef signer, SecStaticCodeRef code, SecCSFlags flags);

#ifdef OURO_NATIVE_COVERAGE
static unsigned long coverage_fault_ordinal = 0U;
static unsigned long coverage_operation_ordinal = 0U;

static int coverage_fail_now(void) {
  coverage_operation_ordinal += 1U;
  return coverage_operation_ordinal == coverage_fault_ordinal;
}

static void *driver_malloc(size_t length) {
  return coverage_fail_now() ? NULL : malloc(length);
}

static OSStatus driver_status(OSStatus status) {
  return coverage_fail_now() ? errSecInternalComponent : status;
}

static CFTypeRef driver_cf_pointer(CFTypeRef value) {
  return coverage_fail_now() ? NULL : value;
}

static int driver_posix_result(int value) {
  if (coverage_fail_now()) {
    errno = EIO;
    return -1;
  }
  return value;
}

static ssize_t driver_io_result(ssize_t value) {
  return coverage_fail_now() ? -1 : value;
}

static int driver_stream_error(int value) {
  return coverage_fail_now() ? 1 : value;
}

static CFTypeRef driver_dictionary_value(CFTypeRef value) {
  return coverage_fail_now() ? NULL : value;
}

static CFIndex driver_count(CFIndex value) {
  return coverage_fail_now() ? 0 : value;
}

static CFTypeID driver_type_id(CFTypeID value) {
  return coverage_fail_now() ? 0 : value;
}

static int driver_cf_string_result(int value) {
  return coverage_fail_now() ? 0 : value;
}

static int driver_open_descriptor(int descriptor) {
  if (coverage_fail_now()) {
    close(descriptor);
    errno = EIO;
    return -1;
  }
  return descriptor;
}
#else
#define driver_malloc(length) malloc(length)
#define driver_status(status) (status)
#define driver_cf_pointer(value) (value)
#define driver_posix_result(value) (value)
#define driver_io_result(value) (value)
#define driver_stream_error(value) (value)
#define driver_dictionary_value(value) (value)
#define driver_count(value) (value)
#define driver_type_id(value) (value)
#define driver_cf_string_result(value) (value)
#define driver_open_descriptor(value) (value)
#endif

static void clear_bytes(void *pointer, size_t length) {
  volatile unsigned char *bytes = (volatile unsigned char *)pointer;
  while (length > 0U) {
    *bytes++ = 0U;
    length -= 1U;
  }
}

static int disable_core_dumps(void) {
  const struct rlimit limit = { 0, 0 };
  return driver_posix_result(setrlimit(RLIMIT_CORE, &limit)) == 0;
}

static uint32_t read_u32_be(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24U)
    | ((uint32_t)bytes[1] << 16U)
    | ((uint32_t)bytes[2] << 8U)
    | (uint32_t)bytes[3];
}

static void append_bytes(char *target, size_t *offset, const void *source, size_t length) {
  memcpy(target + *offset, source, length);
  *offset += length;
}

static void hex_encode_sha256(const unsigned char digest[CC_SHA256_DIGEST_LENGTH], char output[65]) {
  static const char digits[] = "0123456789abcdef";
  for (size_t index = 0U; index < CC_SHA256_DIGEST_LENGTH; index += 1U) {
    output[index * 2U] = digits[digest[index] >> 4U];
    output[index * 2U + 1U] = digits[digest[index] & 0x0fU];
  }
  output[64] = '\0';
}

static int parse_frame(
  unsigned char *storage,
  size_t total,
  uint32_t required_fields,
  byte_field *fields
) {
  if (total < 4U || total > (size_t)MAXIMUM_FRAME_BYTES
    || read_u32_be(storage) != required_fields) {
    return 0;
  }
  size_t offset = 4U;
  for (uint32_t field = 0U; field < required_fields; field += 1U) {
    if (offset + 4U > total) return 0;
    const uint32_t length = read_u32_be(storage + offset);
    offset += 4U;
    if (length == 0U || length > MAXIMUM_FIELD_BYTES || offset + (size_t)length > total) {
      return 0;
    }
    fields[field].bytes = storage + offset;
    fields[field].length = (size_t)length;
    offset += (size_t)length;
  }
  return offset == total;
}

static int read_exact_file(const char *path, unsigned char **bytes, size_t *length) {
  const int descriptor = driver_open_descriptor(open(path, O_RDONLY | O_NOFOLLOW));
  if (descriptor < 0) return 0;
  struct stat status;
  if (driver_posix_result(fstat(descriptor, &status)) != 0 || !S_ISREG(status.st_mode)
    || status.st_size <= 0 || status.st_size > (off_t)MAXIMUM_FRAME_BYTES) {
    close(descriptor);
    return 0;
  }
  unsigned char *buffer = (unsigned char *)driver_malloc((size_t)status.st_size);
  if (buffer == NULL) {
    close(descriptor);
    return 0;
  }
  size_t offset = 0U;
  while (offset < (size_t)status.st_size) {
    const ssize_t count = driver_io_result(
      read(descriptor, buffer + offset, (size_t)status.st_size - offset));
    if (count <= 0) {
      clear_bytes(buffer, (size_t)status.st_size);
      free(buffer);
      close(descriptor);
      return 0;
    }
    offset += (size_t)count;
  }
  unsigned char extra = 0U;
  const ssize_t trailing = driver_io_result(read(descriptor, &extra, 1U));
  close(descriptor);
  if (trailing != 0) {
    clear_bytes(buffer, (size_t)status.st_size);
    free(buffer);
    return 0;
  }
  *bytes = buffer;
  *length = (size_t)status.st_size;
  return 1;
}

static int load_plan(public_plan *plan) {
  memset(plan, 0, sizeof(*plan));
  if (!read_exact_file(PLAN_PATH, &plan->storage, &plan->storage_length)) return 0;
  if (!parse_frame(plan->storage, plan->storage_length, PLAN_FIELDS, plan->fields)) {
    clear_bytes(plan->storage, plan->storage_length);
    free(plan->storage);
    memset(plan, 0, sizeof(*plan));
    return 0;
  }
  return 1;
}

static void clear_plan(public_plan *plan) {
  if (plan->storage != NULL) {
    clear_bytes(plan->storage, plan->storage_length);
    free(plan->storage);
  }
  memset(plan, 0, sizeof(*plan));
}

static int read_stdin_frame(unsigned char **storage, size_t *length, byte_field *fields) {
  unsigned char *frame = (unsigned char *)driver_malloc((size_t)MAXIMUM_FRAME_BYTES + 1U);
  if (frame == NULL) return 0;
  size_t total = 0U;
  while (total <= (size_t)MAXIMUM_FRAME_BYTES) {
    const size_t count = fread(
      frame + total,
      1U,
      ((size_t)MAXIMUM_FRAME_BYTES + 1U) - total,
      stdin
    );
    total += count;
    if (count == 0U) break;
  }
  if (driver_stream_error(ferror(stdin)) != 0 || !parse_frame(frame, total, REQUIRED_FIELDS, fields)) {
    clear_bytes(frame, (size_t)MAXIMUM_FRAME_BYTES + 1U);
    free(frame);
    return 0;
  }
  *storage = frame;
  *length = (size_t)MAXIMUM_FRAME_BYTES + 1U;
  return 1;
}

static int safe_token(const byte_field *field, int allow_base64) {
  for (size_t index = 0U; index < field->length; index += 1U) {
    const unsigned char value = field->bytes[index];
    const int ordinary = (value >= (unsigned char)'A' && value <= (unsigned char)'Z')
      || (value >= (unsigned char)'a' && value <= (unsigned char)'z')
      || (value >= (unsigned char)'0' && value <= (unsigned char)'9')
      || value == (unsigned char)'-' || value == (unsigned char)'_' || value == (unsigned char)'.';
    if (!ordinary && !(allow_base64 && (value == (unsigned char)'+' || value == (unsigned char)'/'
      || value == (unsigned char)'='))) return 0;
  }
  return 1;
}

static int copy_field_string(const byte_field *field, char **value) {
  if (memchr(field->bytes, 0, field->length) != NULL) return 0;
  char *copy = (char *)driver_malloc(field->length + 1U);
  if (copy == NULL) return 0;
  memcpy(copy, field->bytes, field->length);
  copy[field->length] = '\0';
  *value = copy;
  return 1;
}

static const char BASE64_ALPHABET[] =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int base64_index(unsigned char value) {
  const char *position = strchr(BASE64_ALPHABET, (int)value);
  return position == NULL ? -1 : (int)(position - BASE64_ALPHABET);
}

static char *base64_encode(const unsigned char *bytes, size_t length) {
  const size_t output_length = ((length + 2U) / 3U) * 4U;
  char *output = (char *)driver_malloc(output_length + 1U);
  if (output == NULL) return NULL;
  size_t input = 0U;
  size_t cursor = 0U;
  while (input < length) {
    const size_t remaining = length - input;
    const uint32_t first = bytes[input++];
    const uint32_t second = remaining > 1U ? bytes[input++] : 0U;
    const uint32_t third = remaining > 2U ? bytes[input++] : 0U;
    const uint32_t value = (first << 16U) | (second << 8U) | third;
    output[cursor++] = BASE64_ALPHABET[(value >> 18U) & 63U];
    output[cursor++] = BASE64_ALPHABET[(value >> 12U) & 63U];
    output[cursor++] = remaining > 1U ? BASE64_ALPHABET[(value >> 6U) & 63U] : '=';
    output[cursor++] = remaining > 2U ? BASE64_ALPHABET[value & 63U] : '=';
  }
  output[cursor] = '\0';
  return output;
}

static unsigned char *base64_decode(const byte_field *field, size_t *decoded_length) {
  if (field->length == 0U || field->length % 4U != 0U) return NULL;
  size_t padding = 0U;
  if (field->bytes[field->length - 1U] == (unsigned char)'=') padding += 1U;
  if (field->bytes[field->length - 2U] == (unsigned char)'=') padding += 1U;
  const size_t output_length = (field->length / 4U) * 3U - padding;
  unsigned char *output = (unsigned char *)driver_malloc(output_length);
  if (output == NULL) return NULL;
  size_t cursor = 0U;
  for (size_t input = 0U; input < field->length; input += 4U) {
    int values[4];
    for (size_t ordinal = 0U; ordinal < 4U; ordinal += 1U) {
      const unsigned char character = field->bytes[input + ordinal];
      values[ordinal] = character == (unsigned char)'=' ? 0 : base64_index(character);
      if (values[ordinal] < 0) {
        clear_bytes(output, output_length);
        free(output);
        return NULL;
      }
    }
    const uint32_t value = ((uint32_t)values[0] << 18U) | ((uint32_t)values[1] << 12U)
      | ((uint32_t)values[2] << 6U) | (uint32_t)values[3];
    output[cursor++] = (unsigned char)(value >> 16U);
    if (cursor < output_length) output[cursor++] = (unsigned char)(value >> 8U);
    if (cursor < output_length) output[cursor++] = (unsigned char)value;
  }
  char *canonical = base64_encode(output, output_length);
  if (canonical == NULL || memcmp(canonical, field->bytes, field->length) != 0) {
    if (canonical != NULL) free(canonical);
    clear_bytes(output, output_length);
    free(output);
    return NULL;
  }
  free(canonical);
  *decoded_length = output_length;
  return output;
}

static int commitment_matches(
  const byte_field *secret,
  const byte_field *transaction,
  const byte_field *attempt,
  const byte_field *generation,
  const byte_field *nonce,
  const char *domain,
  const byte_field *expected
) {
  if (!safe_token(transaction, 0) || !safe_token(attempt, 0) || !safe_token(generation, 0)
    || !safe_token(nonce, 1) || expected->length != 43U) return 0;
  char *value_base64 = base64_encode(secret->bytes, secret->length);
  if (value_base64 == NULL) return 0;
  static const char attempt_prefix[] = "{\"attemptId\":\"";
  static const char domain_prefix[] = "\",\"domain\":\"";
  static const char nonce_prefix[] = "\",\"nonceBase64\":\"";
  static const char generation_prefix[] = "\",\"pairGenerationId\":\"";
  static const char scheme_prefix[] =
    "\",\"scheme\":\"sha256-jcs-one-time-nonce-v1\",\"transactionId\":\"";
  static const char value_prefix[] = "\",\"valueUtf8Base64\":\"";
  static const char suffix[] = "\"}";
  const size_t value_length = strlen(value_base64);
  const size_t domain_length = strlen(domain);
  const size_t required = sizeof(attempt_prefix) - 1U + attempt->length
    + sizeof(domain_prefix) - 1U + domain_length
    + sizeof(nonce_prefix) - 1U + nonce->length
    + sizeof(generation_prefix) - 1U + generation->length
    + sizeof(scheme_prefix) - 1U + transaction->length
    + sizeof(value_prefix) - 1U + value_length + sizeof(suffix) - 1U;
  char *preimage = (char *)driver_malloc(required + 1U);
  if (preimage == NULL) {
    clear_bytes(value_base64, value_length);
    free(value_base64);
    return 0;
  }
  size_t offset = 0U;
  append_bytes(preimage, &offset, attempt_prefix, sizeof(attempt_prefix) - 1U);
  append_bytes(preimage, &offset, attempt->bytes, attempt->length);
  append_bytes(preimage, &offset, domain_prefix, sizeof(domain_prefix) - 1U);
  append_bytes(preimage, &offset, domain, domain_length);
  append_bytes(preimage, &offset, nonce_prefix, sizeof(nonce_prefix) - 1U);
  append_bytes(preimage, &offset, nonce->bytes, nonce->length);
  append_bytes(preimage, &offset, generation_prefix, sizeof(generation_prefix) - 1U);
  append_bytes(preimage, &offset, generation->bytes, generation->length);
  append_bytes(preimage, &offset, scheme_prefix, sizeof(scheme_prefix) - 1U);
  append_bytes(preimage, &offset, transaction->bytes, transaction->length);
  append_bytes(preimage, &offset, value_prefix, sizeof(value_prefix) - 1U);
  append_bytes(preimage, &offset, value_base64, value_length);
  append_bytes(preimage, &offset, suffix, sizeof(suffix) - 1U);
  preimage[offset] = '\0';
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CC_SHA256(preimage, (CC_LONG)required, digest);
#pragma clang diagnostic pop
  char *encoded = base64_encode(digest, sizeof(digest));
  if (encoded != NULL) {
    for (size_t index = 0U; encoded[index] != '\0'; index += 1U) {
      if (encoded[index] == '+') encoded[index] = '-';
      if (encoded[index] == '/') encoded[index] = '_';
    }
  }
  const int matches = encoded != NULL && memcmp(encoded, expected->bytes, 43U) == 0;
  if (encoded != NULL) {
    clear_bytes(encoded, strlen(encoded));
    free(encoded);
  }
  clear_bytes(digest, sizeof(digest));
  clear_bytes(preimage, required);
  clear_bytes(value_base64, value_length);
  free(preimage);
  free(value_base64);
  return matches;
}

static int cf_string_equals_bytes(CFStringRef value, const byte_field *expected) {
  if (value == NULL) return 0;
  const CFIndex length = CFStringGetLength(value);
  const CFIndex maximum = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  char *buffer = (char *)driver_malloc((size_t)maximum);
  if (buffer == NULL) return 0;
  const int converted = driver_cf_string_result(
    CFStringGetCString(value, buffer, maximum, kCFStringEncodingUTF8));
  const int matches = converted && strlen(buffer) == expected->length
    && memcmp(buffer, expected->bytes, expected->length) == 0;
  clear_bytes(buffer, (size_t)maximum);
  free(buffer);
  return matches;
}

static CFStringRef certificate_organizational_unit(SecCertificateRef certificate) {
  CFErrorRef error = NULL;
  CFDictionaryRef values = (CFDictionaryRef)driver_cf_pointer(
    SecCertificateCopyValues(certificate, NULL, &error)
  );
  if (error != NULL) CFRelease(error);
  if (values == NULL) return NULL;
  CFDictionaryRef subject = (CFDictionaryRef)driver_dictionary_value(
    CFDictionaryGetValue(values, kSecOIDX509V1SubjectName));
  CFTypeRef raw = subject == NULL ? NULL : driver_dictionary_value(
    CFDictionaryGetValue(subject, kSecPropertyKeyValue));
  CFStringRef result = NULL;
  if (raw != NULL && driver_type_id(CFGetTypeID(raw)) == CFArrayGetTypeID()) {
    const CFArrayRef attributes = (CFArrayRef)raw;
    for (CFIndex index = 0; index < driver_count(CFArrayGetCount(attributes)); index += 1) {
      CFDictionaryRef item = (CFDictionaryRef)CFArrayGetValueAtIndex(attributes, index);
      CFStringRef label = (CFStringRef)driver_dictionary_value(
        CFDictionaryGetValue(item, kSecPropertyKeyLabel));
      CFTypeRef item_value = driver_dictionary_value(CFDictionaryGetValue(item, kSecPropertyKeyValue));
      const int organizational_unit = label != NULL && CFEqual(label, kSecOIDOrganizationalUnitName);
      if (organizational_unit && item_value != NULL
        && driver_type_id(CFGetTypeID(item_value)) == CFStringGetTypeID()) {
        result = (CFStringRef)CFRetain(item_value);
        break;
      }
    }
  }
  CFRelease(values);
  return result;
}

static int same_file_identity(const struct stat *left, const struct stat *right) {
  return S_ISREG(left->st_mode) && S_ISREG(right->st_mode)
    && left->st_nlink == 1 && right->st_nlink == 1
    && left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int path_matches_descriptor(const char *path_value, int descriptor) {
  struct stat path_status;
  struct stat descriptor_status;
  if (driver_posix_result(lstat(path_value, &path_status)) != 0
    || driver_posix_result(fstat(descriptor, &descriptor_status)) != 0) return 0;
  return same_file_identity(&path_status, &descriptor_status);
}

static int sign_and_verify_canary(SecIdentityRef identity, int *canary_descriptor) {
  if (!path_matches_descriptor(CANARY_PATH, *canary_descriptor)) return 0;
  CFURLRef path = (CFURLRef)driver_cf_pointer(CFURLCreateFromFileSystemRepresentation(
    NULL,
    (const UInt8 *)CANARY_PATH,
    (CFIndex)strlen(CANARY_PATH),
    false
  ));
  SecStaticCodeRef code = NULL;
  SecCodeSignerRef signer = NULL;
  CFStringRef identifier = (CFStringRef)driver_cf_pointer(
    CFStringCreateWithCString(NULL, SIGNING_IDENTIFIER, kCFStringEncodingUTF8)
  );
  CFMutableDictionaryRef parameters = (CFMutableDictionaryRef)driver_cf_pointer(CFDictionaryCreateMutable(
    NULL,
    0,
    &kCFTypeDictionaryKeyCallBacks,
    &kCFTypeDictionaryValueCallBacks
  ));
  int success = path != NULL && identifier != NULL && parameters != NULL;
  if (success) {
    CFDictionarySetValue(parameters, kSecCodeSignerIdentity, identity);
    CFDictionarySetValue(parameters, kSecCodeSignerIdentifier, identifier);
    success = driver_status(SecStaticCodeCreateWithPath(path, kSecCSDefaultFlags, &code)) == errSecSuccess
      && driver_status(SecCodeSignerCreate(parameters, kSecCSDefaultFlags, &signer)) == errSecSuccess
      && driver_status(SecCodeSignerAddSignature(signer, code, kSecCSDefaultFlags)) == errSecSuccess
      && driver_status(SecStaticCodeCheckValidity(
        code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL))
        == errSecSuccess;
  }
  if (signer != NULL) CFRelease(signer);
  if (code != NULL) CFRelease(code);
  if (parameters != NULL) CFRelease(parameters);
  if (identifier != NULL) CFRelease(identifier);
  if (path != NULL) CFRelease(path);
  int signed_descriptor = -1;
  if (success) {
    signed_descriptor = driver_open_descriptor(open(CANARY_PATH, O_RDONLY | O_NOFOLLOW));
    success = signed_descriptor >= 0 && path_matches_descriptor(CANARY_PATH, signed_descriptor);
  }
  if (success) {
    close(*canary_descriptor);
    *canary_descriptor = signed_descriptor;
  } else if (signed_descriptor >= 0) {
    close(signed_descriptor);
  }
  return success;
}

static int sha256_descriptor(int descriptor, char output[65]) {
  struct stat status;
  if (driver_posix_result(fstat(descriptor, &status)) != 0 || !S_ISREG(status.st_mode)) return 0;
  unsigned char bytes[65536];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_CTX context;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CC_SHA256_Init(&context);
  off_t offset = 0;
  while (offset < status.st_size) {
    const size_t remaining = (size_t)(status.st_size - offset);
    const size_t requested = remaining < sizeof(bytes) ? remaining : sizeof(bytes);
    const ssize_t count = driver_io_result(pread(descriptor, bytes, requested, offset));
    if (count <= 0) {
      clear_bytes(bytes, sizeof(bytes));
      clear_bytes(&context, sizeof(context));
      return 0;
    }
    CC_SHA256_Update(&context, bytes, (CC_LONG)count);
    offset += count;
  }
  CC_SHA256_Final(digest, &context);
#pragma clang diagnostic pop
  clear_bytes(bytes, sizeof(bytes));
  clear_bytes(&context, sizeof(context));
  hex_encode_sha256(digest, output);
  clear_bytes(digest, sizeof(digest));
  return 1;
}

static int execute_canary(void) {
  int failure_stage = 1;
  if (!disable_core_dumps()) {
    fputs("unable to disable core dumps\n", stderr);
    return 65;
  }
  public_plan plan;
  if (!load_plan(&plan)) {
    fputs("invalid native plan\n", stderr);
    return 65;
  }
  int canary_descriptor = driver_open_descriptor(open(CANARY_PATH, O_RDONLY | O_NOFOLLOW));
  if (canary_descriptor < 0 || !path_matches_descriptor(CANARY_PATH, canary_descriptor)) {
    if (canary_descriptor >= 0) close(canary_descriptor);
    clear_plan(&plan);
    fputs("invalid canary input\n", stderr);
    return 65;
  }
  byte_field fields[REQUIRED_FIELDS];
  memset(fields, 0, sizeof(fields));
  unsigned char *frame = NULL;
  size_t frame_length = 0U;
  if (!read_stdin_frame(&frame, &frame_length, fields)) {
    close(canary_descriptor);
    clear_plan(&plan);
    fputs("invalid stdin frame\n", stderr);
    return 65;
  }

  int success = commitment_matches(&fields[0], &plan.fields[0], &plan.fields[1], &plan.fields[2],
      &plan.fields[3], "ouro-developer-id-p12-b64-v1", &plan.fields[4])
    && commitment_matches(&fields[1], &plan.fields[0], &plan.fields[1], &plan.fields[2],
      &plan.fields[3], "ouro-developer-id-p12-password-v1", &plan.fields[5]);
  if (success) failure_stage = 2;
  size_t p12_length = 0U;
  unsigned char *p12_bytes = success ? base64_decode(&fields[0], &p12_length) : NULL;
  success = success && p12_bytes != NULL;
  if (success) failure_stage = 3;

  char *password = NULL;
  char *team = NULL;
  char *common_name = NULL;
  char keychain_path[] = "/tmp/ouro-pair-canary-XXXXXX";
  int temporary_descriptor = -1;
  SecKeychainRef keychain = NULL;
  SecIdentityRef identity = NULL;
  SecCertificateRef certificate = NULL;
  CFStringRef imported_common_name = NULL;
  CFStringRef imported_team = NULL;
  CFDataRef p12_data = NULL;
  CFStringRef password_string = NULL;
  CFMutableDictionaryRef options = NULL;
  CFArrayRef imported = NULL;
  char certificate_sha256[65];
  char canary_sha256[65];
  memset(certificate_sha256, 0, sizeof(certificate_sha256));
  memset(canary_sha256, 0, sizeof(canary_sha256));

  if (success) success = copy_field_string(&fields[1], &password)
    && copy_field_string(&fields[2], &team)
    && copy_field_string(&fields[3], &common_name);
  if (success) failure_stage = 4;
  if (success) {
    temporary_descriptor = driver_posix_result(mkstemp(keychain_path));
    success = temporary_descriptor >= 0;
  }
  if (temporary_descriptor >= 0) {
    close(temporary_descriptor);
    temporary_descriptor = -1;
    if (driver_posix_result(unlink(keychain_path)) != 0) success = 0;
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  if (success) success = driver_status(SecKeychainCreate(keychain_path, (UInt32)fields[1].length,
    password, FALSE, NULL, &keychain)) == errSecSuccess;
#pragma clang diagnostic pop
  if (success) failure_stage = 5;
  if (success) {
    p12_data = (CFDataRef)driver_cf_pointer(CFDataCreate(NULL, p12_bytes, (CFIndex)p12_length));
    password_string = (CFStringRef)driver_cf_pointer(CFStringCreateWithBytes(
      NULL, fields[1].bytes, (CFIndex)fields[1].length, kCFStringEncodingUTF8, false));
    options = (CFMutableDictionaryRef)driver_cf_pointer(CFDictionaryCreateMutable(
      NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
    success = p12_data != NULL && password_string != NULL && options != NULL;
  }
  if (success) failure_stage = 6;
  if (success) {
    CFDictionarySetValue(options, kSecImportExportPassphrase, password_string);
    CFDictionarySetValue(options, kSecImportExportKeychain, keychain);
    const OSStatus import_status = driver_status(SecPKCS12Import(p12_data, options, &imported));
    const CFArrayRef checked_imported = (CFArrayRef)driver_cf_pointer(imported);
    success = import_status == errSecSuccess && checked_imported != NULL
      && driver_count(CFArrayGetCount(checked_imported)) == 1;
  }
  if (success) failure_stage = 7;
  if (success) {
    CFDictionaryRef item = (CFDictionaryRef)CFArrayGetValueAtIndex(imported, 0);
    SecIdentityRef imported_identity = (SecIdentityRef)driver_dictionary_value(
      CFDictionaryGetValue(item, kSecImportItemIdentity));
    if (imported_identity != NULL) identity = (SecIdentityRef)CFRetain(imported_identity);
    success = identity != NULL
      && driver_status(SecIdentityCopyCertificate(identity, &certificate)) == errSecSuccess;
  }
  if (success) failure_stage = 8;
  if (success) {
    success = driver_status(SecCertificateCopyCommonName(certificate, &imported_common_name))
      == errSecSuccess;
    if (success && cf_string_equals_bytes(imported_common_name, &fields[3])) failure_stage = 81;
    else success = 0;
    imported_team = certificate_organizational_unit(certificate);
    if (success && cf_string_equals_bytes(imported_team, &fields[2])) failure_stage = 82;
    else success = 0;
  }
  if (success) failure_stage = 9;
  if (success) {
    CFDataRef certificate_data = (CFDataRef)driver_cf_pointer(SecCertificateCopyData(certificate));
    if (certificate_data == NULL) {
      success = 0;
    } else {
      unsigned char digest[CC_SHA256_DIGEST_LENGTH];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      CC_SHA256(CFDataGetBytePtr(certificate_data), (CC_LONG)CFDataGetLength(certificate_data), digest);
#pragma clang diagnostic pop
      hex_encode_sha256(digest, certificate_sha256);
      clear_bytes(digest, sizeof(digest));
      CFRelease(certificate_data);
    }
  }
  if (success) failure_stage = 10;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  if (success) success = driver_status(SecKeychainUnlock(
    keychain, (UInt32)fields[1].length, password, TRUE)) == errSecSuccess;
#pragma clang diagnostic pop
  if (success) failure_stage = 11;
  if (success) success = sign_and_verify_canary(identity, &canary_descriptor);
  if (success) failure_stage = 112;
  if (success) success = sha256_descriptor(canary_descriptor, canary_sha256)
    && path_matches_descriptor(CANARY_PATH, canary_descriptor);
  if (success) failure_stage = 113;
  if (success) failure_stage = 12;

  if (imported_team != NULL) CFRelease(imported_team);
  if (imported_common_name != NULL) CFRelease(imported_common_name);
  if (certificate != NULL) CFRelease(certificate);
  if (identity != NULL) CFRelease(identity);
  if (imported != NULL) CFRelease(imported);
  if (options != NULL) CFRelease(options);
  if (password_string != NULL) CFRelease(password_string);
  if (p12_data != NULL) CFRelease(p12_data);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  if (keychain != NULL && driver_status(SecKeychainDelete(keychain)) != errSecSuccess) success = 0;
#pragma clang diagnostic pop
  if (keychain != NULL) CFRelease(keychain);
  if (driver_posix_result(unlink(keychain_path)) != 0 && errno != ENOENT) success = 0;

  if (password != NULL) {
    clear_bytes(password, fields[1].length);
    free(password);
  }
  if (p12_bytes != NULL) {
    clear_bytes(p12_bytes, p12_length);
    free(p12_bytes);
  }
  clear_bytes(frame, frame_length);
  free(frame);
  clear_plan(&plan);
  close(canary_descriptor);

  if (!success) {
    if (team != NULL) {
      clear_bytes(team, fields[2].length);
      free(team);
    }
    if (common_name != NULL) {
      clear_bytes(common_name, fields[3].length);
      free(common_name);
    }
    fprintf(stderr, "canary signing failed at stage %d\n", failure_stage);
    return 65;
  }
  printf(
    "{\"applicationCommonName\":\"%.*s\",\"certificateDerSha256\":\"%s\","
    "\"ephemeralKeychainRemoved\":true,\"schemaVersion\":1,\"secretValuesPersisted\":false,"
    "\"signedCanaryMachOSha256\":\"%s\",\"teamIdentifier\":\"%.*s\"}\n",
    (int)strlen(common_name), common_name, certificate_sha256, canary_sha256,
    (int)strlen(team), team
  );
  clear_bytes(common_name, strlen(common_name));
  clear_bytes(team, strlen(team));
  free(common_name);
  free(team);
  clear_bytes(certificate_sha256, sizeof(certificate_sha256));
  clear_bytes(canary_sha256, sizeof(canary_sha256));
  return 0;
}

#ifdef OURO_NATIVE_COVERAGE
static int run_coverage_probes(void) {
  public_plan empty_plan;
  memset(&empty_plan, 0, sizeof(empty_plan));
  clear_plan(&empty_plan);
  unsigned char frame_bytes[24] = { 0, 0, 0, 1, 0, 0, 0, 1, 'x' };
  byte_field parsed[4];
  memset(parsed, 0, sizeof(parsed));
  (void)parse_frame(frame_bytes, 3U, 1U, parsed);
  (void)parse_frame(frame_bytes, (size_t)MAXIMUM_FRAME_BYTES + 1U, 1U, parsed);
  (void)parse_frame(frame_bytes, 9U, 2U, parsed);
  (void)parse_frame(frame_bytes, 9U, 1U, parsed);
  (void)parse_frame(frame_bytes, 4U, 1U, parsed);
  frame_bytes[7] = 0U;
  (void)parse_frame(frame_bytes, 8U, 1U, parsed);
  frame_bytes[7] = 1U;
  frame_bytes[4] = 0xffU;
  frame_bytes[5] = 0xffU;
  (void)parse_frame(frame_bytes, 9U, 1U, parsed);
  frame_bytes[4] = 0U;
  frame_bytes[5] = 0U;

  unsigned char *file_bytes = NULL;
  size_t file_length = 0U;
  (void)read_exact_file(".", &file_bytes, &file_length);
  (void)read_exact_file("definitely-not-a-file", &file_bytes, &file_length);
  (void)read_exact_file("coverage-empty-file", &file_bytes, &file_length);
  (void)read_exact_file("coverage-oversized-file", &file_bytes, &file_length);

  unsigned char token_bytes[] = { 'A', 'a', '0', '-', '_', '.', '+', '/', '=', ' ', 0U };
  byte_field token = { token_bytes, 1U };
  for (size_t index = 0U; index < sizeof(token_bytes) - 1U; index += 1U) {
    token.bytes = token_bytes + index;
    (void)safe_token(&token, 0);
    (void)safe_token(&token, 1);
  }
  token.bytes = token_bytes + sizeof(token_bytes) - 1U;
  char *copy = NULL;
  (void)copy_field_string(&token, &copy);

  const unsigned char one[] = { 'a' };
  const unsigned char two[] = { 'a', 'b' };
  char *encoded_one = base64_encode(one, sizeof(one));
  char *encoded_two = base64_encode(two, sizeof(two));
  free(encoded_one);
  free(encoded_two);
  unsigned char empty_base64_bytes[] = { 0U };
  byte_field invalid_base64 = { empty_base64_bytes, 0U };
  size_t decoded_length = 0U;
  (void)base64_decode(&invalid_base64, &decoded_length);
  unsigned char short_base64_bytes[] = { 'A', 'A', 'A' };
  invalid_base64.bytes = short_base64_bytes;
  invalid_base64.length = sizeof(short_base64_bytes);
  (void)base64_decode(&invalid_base64, &decoded_length);
  unsigned char invalid_base64_bytes[] = { 'A', '!', '=', '=' };
  invalid_base64.bytes = invalid_base64_bytes;
  invalid_base64.length = sizeof(invalid_base64_bytes);
  unsigned char *decoded = base64_decode(&invalid_base64, &decoded_length);
  free(decoded);
  unsigned char noncanonical_base64_bytes[] = { 'A', 'A', '=', 'A' };
  invalid_base64.bytes = noncanonical_base64_bytes;
  decoded = base64_decode(&invalid_base64, &decoded_length);
  free(decoded);
  unsigned char padded_one_bytes[] = { 'Q', 'Q', '=', '=' };
  unsigned char padded_two_bytes[] = { 'Q', 'U', 'I', '=' };
  unsigned char padded_three_bytes[] = { 'Q', 'U', 'J', 'D' };
  byte_field valid_base64[] = {
    { padded_one_bytes, sizeof(padded_one_bytes) },
    { padded_two_bytes, sizeof(padded_two_bytes) },
    { padded_three_bytes, sizeof(padded_three_bytes) },
  };
  for (size_t index = 0U; index < 3U; index += 1U) {
    decoded = base64_decode(&valid_base64[index], &decoded_length);
    free(decoded);
  }

  byte_field empty = { frame_bytes, 0U };
  (void)commitment_matches(&empty, &empty, &empty, &empty, &empty, "domain", &empty);
  unsigned char valid_token_byte[] = { 'x' };
  unsigned char invalid_token_byte[] = { ' ' };
  unsigned char expected_bytes[43];
  memset(expected_bytes, 'x', sizeof(expected_bytes));
  byte_field valid_token = { valid_token_byte, sizeof(valid_token_byte) };
  byte_field invalid_token = { invalid_token_byte, sizeof(invalid_token_byte) };
  byte_field expected = { expected_bytes, sizeof(expected_bytes) };
  (void)commitment_matches(&empty, &invalid_token, &valid_token, &valid_token, &valid_token, "domain", &expected);
  (void)commitment_matches(&empty, &valid_token, &invalid_token, &valid_token, &valid_token, "domain", &expected);
  (void)commitment_matches(&empty, &valid_token, &valid_token, &invalid_token, &valid_token, "domain", &expected);
  (void)commitment_matches(&empty, &valid_token, &valid_token, &valid_token, &invalid_token, "domain", &expected);
  for (size_t value = 0U; value < 256U; value += 1U) {
    unsigned char secret_byte = (unsigned char)value;
    byte_field secret = { &secret_byte, 1U };
    (void)commitment_matches(
      &secret, &valid_token, &valid_token, &valid_token, &valid_token, "domain", &expected);
  }
  (void)cf_string_equals_bytes(NULL, &empty);
  CFStringRef string = CFSTR("abc");
  unsigned char equal_bytes[] = { 'a', 'b', 'c' };
  unsigned char different_bytes[] = { 'a', 'b', 'd' };
  byte_field equal = { equal_bytes, sizeof(equal_bytes) };
  byte_field different = { different_bytes, sizeof(different_bytes) };
  (void)cf_string_equals_bytes(string, &empty);
  (void)cf_string_equals_bytes(string, &different);
  (void)cf_string_equals_bytes(string, &equal);
  (void)certificate_organizational_unit(NULL);
  struct stat left;
  struct stat right;
  memset(&left, 0, sizeof(left));
  memset(&right, 0, sizeof(right));
  left.st_mode = S_IFREG;
  right.st_mode = S_IFREG;
  left.st_nlink = 1;
  right.st_nlink = 1;
  left.st_dev = 1;
  right.st_dev = 1;
  left.st_ino = 1;
  right.st_ino = 1;
  (void)same_file_identity(&left, &right);
  left.st_mode = S_IFDIR;
  (void)same_file_identity(&left, &right);
  left.st_mode = S_IFREG;
  right.st_mode = S_IFDIR;
  (void)same_file_identity(&left, &right);
  right.st_mode = S_IFREG;
  left.st_nlink = 2;
  (void)same_file_identity(&left, &right);
  left.st_nlink = 1;
  right.st_nlink = 2;
  (void)same_file_identity(&left, &right);
  right.st_nlink = 1;
  right.st_dev = 2;
  (void)same_file_identity(&left, &right);
  right.st_dev = 1;
  right.st_ino = 2;
  (void)same_file_identity(&left, &right);
  (void)path_matches_descriptor("definitely-not-a-file", -1);
  char digest[65];
  (void)sha256_descriptor(-1, digest);
  const int directory_descriptor = open(".", O_RDONLY);
  (void)sha256_descriptor(directory_descriptor, digest);
  close(directory_descriptor);
  const int large_descriptor = open("coverage-oversized-file", O_RDONLY);
  (void)sha256_descriptor(large_descriptor, digest);
  close(large_descriptor);
  return 0;
}
#endif

int main(int argc, char **argv) {
#ifdef OURO_NATIVE_COVERAGE
  if (argc == 2 && strcmp(argv[1], "--coverage-probe") == 0) return run_coverage_probes();
  if (argc == 3 && strcmp(argv[1], "--coverage-execute") == 0) {
    coverage_fault_ordinal = strtoul(argv[2], NULL, 10);
    coverage_operation_ordinal = 0U;
    return execute_canary();
  }
#endif
  if (argc == 2 && strcmp(argv[1], "--contract") == 0) {
    fputs(
      "{\"acceptedModes\":[\"--contract\",\"--execute\"],"
      "\"driver\":\"developer-id-pair-canary\","
      "\"frame\":{\"exact\":true,\"maximumFieldBytes\":1048576,\"requiredFields\":4},"
      "\"nativePlan\":\"developer-id-pair-canary-native-plan.v1.bin\","
      "\"schemaVersion\":1,\"secretTransport\":\"stdin-only\","
      "\"sideEffects\":\"ephemeral-keychain-canary-signing\"}\n",
      stdout
    );
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--execute") == 0) return execute_canary();
  fputs("usage: developer-id-pair-canary-driver --contract | --execute\n", stderr);
  return 64;
}
