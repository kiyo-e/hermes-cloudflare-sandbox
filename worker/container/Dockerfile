# Base pinned by digest: an unpinned tag silently changes the image, and a new image
# replaces running workspaces (unsaved files are lost). Update deliberately.
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git python3 python3-venv python-is-python3 \
    ripgrep procps build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash hermes \
    && mkdir -p /workspace /home/hermes/.hermes \
    && chown -R hermes:hermes /workspace /home/hermes
COPY hermes-exec.py /usr/local/bin/hermes-exec
RUN chmod 0755 /usr/local/bin/hermes-exec
ENV HOME=/home/hermes
USER hermes
WORKDIR /workspace
CMD ["sleep", "infinity"]
