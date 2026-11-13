/* The example's own native function, to show that a project's own FFI
 * manifest still works next to SQLite's: a 32-bit FNV-1a hash of a string. */
#include <stddef.h>
#include <stdint.h>

uint32_t example_tag(const uint8_t *p, size_t n) {
  uint32_t h = 2166136261u;
  for (size_t i = 0; i < n; i++) {
    h ^= p[i];
    h *= 16777619u;
  }
  return h;
}
