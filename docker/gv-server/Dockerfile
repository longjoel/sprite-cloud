FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates procps \
    # Rust binary runtime deps (from ldd target/release/gv-worker)
    libopus0 libvpx9 libgcc-s1 \
    # HW rendering (libGL for N64/PS1/Dreamcast cores)
    libgl1 libglu1-mesa libegl1 libegl-mesa0 \
    # Xvfb for SW rendering fallback
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Entrypoint
COPY docker/gv-server/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
