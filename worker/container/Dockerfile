FROM node:24-trixie-slim

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
