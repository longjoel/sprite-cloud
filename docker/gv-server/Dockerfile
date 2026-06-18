FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates procps \
    # Rust binary runtime deps (v1: libopus0 + libvpx9)
    libopus0 libvpx9 libgcc-s1 \
    # GStreamer runtime (v2)
    libgstreamer1.0-0 \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    # HW rendering (libGL for N64/PS1/Dreamcast cores)
    libgl1 libglu1-mesa libegl1 libegl-mesa0 \
    # Xvfb for SW rendering fallback
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Entrypoint
COPY docker/gv-server/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
