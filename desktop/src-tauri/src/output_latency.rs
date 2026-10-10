//! Latency of the default audio output device, from Core Audio.
//!
//! WebKit's `AudioContext.outputLatency` rises when output moves to a
//! Bluetooth device but never falls back, even in a new context, so the
//! frontend asks the system directly.

/// Seconds between audio reaching the default output device and being heard,
/// or `None` when it can't be read.
#[cfg(target_os = "macos")]
pub fn default_output_latency() -> Option<f64> {
    core_audio::default_output_latency()
}

#[cfg(not(target_os = "macos"))]
pub fn default_output_latency() -> Option<f64> {
    None
}

#[cfg(target_os = "macos")]
mod core_audio {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr::null;

    const fn fourcc(code: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*code)
    }

    const SYSTEM_OBJECT: u32 = 1;
    const ELEMENT_MAIN: u32 = 0;
    const SCOPE_GLOBAL: u32 = fourcc(b"glob");
    const SCOPE_OUTPUT: u32 = fourcc(b"outp");
    const DEFAULT_OUTPUT_DEVICE: u32 = fourcc(b"dOut");
    const NOMINAL_SAMPLE_RATE: u32 = fourcc(b"nsrt");
    const LATENCY: u32 = fourcc(b"ltnc");
    const SAFETY_OFFSET: u32 = fourcc(b"saft");
    const BUFFER_FRAME_SIZE: u32 = fourcc(b"fsiz");
    const STREAMS: u32 = fourcc(b"stm#");

    #[repr(C)]
    struct PropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const PropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    fn get<T: Default>(object: u32, selector: u32, scope: u32) -> Option<T> {
        let address = PropertyAddress {
            selector,
            scope,
            element: ELEMENT_MAIN,
        };
        let mut value = T::default();
        let mut size = size_of::<T>() as u32;
        // SAFETY: `value` is a plain value of `size` bytes, as Core Audio expects
        // for these fixed-size properties.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                null(),
                &mut size,
                &mut value as *mut T as *mut c_void,
            )
        };
        (status == 0).then_some(value)
    }

    /// Device latency, safety offset, IO buffer and the first output stream's
    /// latency, as Core Audio's own clients add them up.
    pub fn default_output_latency() -> Option<f64> {
        let device: u32 = get(SYSTEM_OBJECT, DEFAULT_OUTPUT_DEVICE, SCOPE_GLOBAL)?;
        let rate: f64 = get(device, NOMINAL_SAMPLE_RATE, SCOPE_GLOBAL)?;
        if rate <= 0.0 {
            return None;
        }
        let frames = |selector| get::<u32>(device, selector, SCOPE_OUTPUT).unwrap_or(0);
        let stream: u32 = get(device, STREAMS, SCOPE_OUTPUT).unwrap_or(0);
        let stream_latency = if stream == 0 {
            0
        } else {
            get::<u32>(stream, LATENCY, SCOPE_GLOBAL).unwrap_or(0)
        };
        let total =
            frames(LATENCY) + frames(SAFETY_OFFSET) + frames(BUFFER_FRAME_SIZE) + stream_latency;
        Some(f64::from(total) / rate)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn reads_a_plausible_latency() {
        // CI machines may have no output device; only check the value when there is one.
        if let Some(seconds) = default_output_latency() {
            assert!((0.0..1.0).contains(&seconds), "{seconds}");
        }
    }
}
