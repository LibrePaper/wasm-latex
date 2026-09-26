/* SPDX-License-Identifier: MIT */
#ifndef LIBREPAPER_SHA2_H
#define LIBREPAPER_SHA2_H

#include <stddef.h>
#include <stdint.h>

void librepaper_sha256(const void *data, size_t size, uint8_t digest[32]);
void librepaper_sha384(const void *data, size_t size, uint8_t digest[48]);
void librepaper_sha512(const void *data, size_t size, uint8_t digest[64]);

#endif
