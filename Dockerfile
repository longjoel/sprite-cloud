# Stage 1: Build the .NET application
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY games-vault.csproj ./
RUN dotnet restore games-vault.csproj

COPY . .
RUN dotnet publish games-vault.csproj -c Release -r linux-x64 -o /out --self-contained true

# Stage 2: Download nosebleed binary from GitHub release
FROM alpine:3.20 AS nosebleed-download
ARG NOSEBLEED_VERSION=v0.1.0
RUN apk add --no-cache curl
RUN curl -fsSL \
    https://github.com/longjoel/nosebleed/releases/download/${NOSEBLEED_VERSION}/nosebleed-linux-x86_64 \
    -o /nosebleed && chmod +x /nosebleed

# Stage 3: Download libretro cores from buildbot
FROM alpine:3.20 AS core-download
ARG CORE_BASE_URL=https://buildbot.libretro.com/nightly/linux/x86_64/latest
RUN apk add --no-cache curl unzip

# Core catalog (must match Nosebleed/CoreCompatibilityCatalog.cs)
RUN set -eux; \
    cores="fceumm_libretro snes9x_libretro mupen64plus_next_libretro mgba_libretro mame2003_plus_libretro genesis_plus_gx_libretro mednafen_pce_fast_libretro mednafen_ngp_libretro stella_libretro"; \
    mkdir -p /cores; \
    for core in $cores; do \
        url="${CORE_BASE_URL}/${core}.so.zip"; \
        echo "Downloading ${core} from ${url}..."; \
        curl -fsSL "$url" -o "/tmp/${core}.zip"; \
        unzip -o "/tmp/${core}.zip" -d /cores/ "${core}.so"; \
        chmod +x "/cores/${core}.so"; \
        rm "/tmp/${core}.zip"; \
    done; \
    echo "=== Cores downloaded ==="; \
    ls -lh /cores/

# Stage 4: GStreamer runtime layer (cached independently, rarely changes)
FROM ubuntu:24.04 AS gstreamer-layer
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gstreamer1.0-tools \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-ugly \
        gstreamer1.0-libav \
        libgstreamer1.0-0 \
        libgstreamer-plugins-base1.0-0 \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -f gv \
    && groupmod -o -g 1000 gv \
    && useradd --create-home --uid 1000 --gid 1000 --shell /bin/bash -o gv \
    && mkdir -p /app /var/lib/games-vault /srv/storage/games-vault /srv/storage/games /srv/storage/games-vault/nosebleed/cores \
    && chown -R gv:gv /app /var/lib/games-vault /srv/storage/games-vault /srv/storage/games

# Stage 5: Final app image
FROM gstreamer-layer AS final

WORKDIR /app
COPY --from=build /out/ ./
RUN chown -R gv:gv /app

# Nosebleed binary and libretro cores (from download stages, not host mount)
COPY --from=nosebleed-download /nosebleed /opt/nosebleed/nosebleed
COPY --from=core-download /cores/*.so /srv/storage/games-vault/nosebleed/cores/
RUN chmod +x /opt/nosebleed/nosebleed && chown -R gv:gv /opt/nosebleed /srv/storage/games-vault/nosebleed

ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    DataProtection__KeyRingPath=/var/lib/games-vault/dp-keys \
    Nosebleed__AuthSecretPath=/var/lib/games-vault/nosebleed-auth-secret

EXPOSE 8080
VOLUME ["/var/lib/games-vault", "/srv/storage/games-vault", "/srv/storage/games"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

STOPSIGNAL SIGTERM

USER gv
ENTRYPOINT ["./games-vault"]
