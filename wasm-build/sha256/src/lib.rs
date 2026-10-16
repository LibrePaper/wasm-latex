//! Streaming SHA-256 (FIPS 180-4) for wasm32, with a fixed input buffer.
//!
//! Usage: call `init`, then repeatedly copy up to `input_capacity()` bytes to
//! `input_ptr()` and call `update(len)`, then call `finish` and read 32 bytes.
#![no_std]

use core::ptr::addr_of_mut;

const INPUT_CAPACITY: usize = 1 << 20;

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H0: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

struct State {
    h: [u32; 8],
    /// Bytes of a partial block carried between calls.
    block: [u8; 64],
    block_len: usize,
    total: u64,
    digest: [u8; 32],
}

static mut INPUT: [u8; INPUT_CAPACITY] = [0; INPUT_CAPACITY];
static mut STATE: State = State {
    h: H0,
    block: [0; 64],
    block_len: 0,
    total: 0,
    digest: [0; 32],
};

fn compress(h: &mut [u32; 8], block: &[u8]) {
    let mut w = [0u32; 64];
    for t in 0..16 {
        w[t] = u32::from_be_bytes([block[4 * t], block[4 * t + 1], block[4 * t + 2], block[4 * t + 3]]);
    }
    for t in 16..64 {
        let s0 = w[t - 15].rotate_right(7) ^ w[t - 15].rotate_right(18) ^ (w[t - 15] >> 3);
        let s1 = w[t - 2].rotate_right(17) ^ w[t - 2].rotate_right(19) ^ (w[t - 2] >> 10);
        w[t] = w[t - 16]
            .wrapping_add(s0)
            .wrapping_add(w[t - 7])
            .wrapping_add(s1);
    }

    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = *h;
    for t in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ (!e & g);
        let t1 = hh
            .wrapping_add(s1)
            .wrapping_add(ch)
            .wrapping_add(K[t])
            .wrapping_add(w[t]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let t2 = s0.wrapping_add(maj);
        hh = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    for (slot, v) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
        *slot = slot.wrapping_add(v);
    }
}

fn absorb(st: &mut State, mut data: &[u8]) {
    st.total = st.total.wrapping_add(data.len() as u64);
    if st.block_len > 0 {
        let take = core::cmp::min(64 - st.block_len, data.len());
        st.block[st.block_len..st.block_len + take].copy_from_slice(&data[..take]);
        st.block_len += take;
        data = &data[take..];
        if st.block_len < 64 {
            return;
        }
        let block = st.block;
        compress(&mut st.h, &block);
        st.block_len = 0;
    }
    while data.len() >= 64 {
        compress(&mut st.h, &data[..64]);
        data = &data[64..];
    }
    st.block[..data.len()].copy_from_slice(data);
    st.block_len = data.len();
}

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 {
    addr_of_mut!(INPUT) as *mut u8
}

#[no_mangle]
pub extern "C" fn input_capacity() -> usize {
    INPUT_CAPACITY
}

#[no_mangle]
pub extern "C" fn init() {
    let st = unsafe { &mut *addr_of_mut!(STATE) };
    st.h = H0;
    st.block_len = 0;
    st.total = 0;
}

/// Hash the first `len` bytes of the input buffer.
#[no_mangle]
pub extern "C" fn update(len: usize) {
    let len = core::cmp::min(len, INPUT_CAPACITY);
    let st = unsafe { &mut *addr_of_mut!(STATE) };
    let input = unsafe { &*addr_of_mut!(INPUT) };
    absorb(st, &input[..len]);
}

/// Pad, finish, and return a pointer to the 32-byte digest.
#[no_mangle]
pub extern "C" fn finish() -> *const u8 {
    let st = unsafe { &mut *addr_of_mut!(STATE) };
    let bit_len = st.total.wrapping_mul(8);

    let mut tail = [0u8; 128];
    let n = st.block_len;
    tail[..n].copy_from_slice(&st.block[..n]);
    tail[n] = 0x80;
    let end = if n < 56 { 64 } else { 128 };
    tail[end - 8..end].copy_from_slice(&bit_len.to_be_bytes());
    compress(&mut st.h, &tail[..64]);
    if end == 128 {
        compress(&mut st.h, &tail[64..]);
    }

    for (i, word) in st.h.iter().enumerate() {
        st.digest[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    st.digest.as_ptr()
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
