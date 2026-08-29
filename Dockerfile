# ── Reverse Engineering Harness — Dockerfile ──────────────────────────────
#
# Multi-stage build:
#   builder  — installs npm production dependencies
#   runtime  — minimal image with Node, Claude CLI, and Docker CLI
#
# The container mounts the host Docker socket so it can spin up
# structurizr/structurizr for DSL preview and validation.
# Target repositories on the host are mounted at /repos (read-write).
#
# Build:
#   docker build -t rev-eng-harness .
#
# Run (see docker-compose.yml for the recommended one-liner):
#   docker run -d \
#     -p 4200:4200 \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v /path/to/your/repos:/repos \
#     -v rev-eng-harness-data:/app/data \
#     -e ANTHROPIC_API_KEY=sk-ant-... \
#     --name rev-eng-harness \
#     rev-eng-harness

# ── Stage 1: dependency installer ─────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Install Docker CLI (needed to call docker run structurizr/structurizr)
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        lsb-release && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) \
        signed-by=/etc/apt/keyrings/docker.gpg] \
        https://download.docker.com/linux/debian \
        $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list && \
    apt-get update -qq && \
    apt-get install -y --no-install-recommends docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally via npm
RUN npm install -g @anthropic-ai/claude-code --quiet

WORKDIR /app

# Copy production node_modules from builder stage
COPY --from=builder /build/node_modules ./node_modules

# Copy application source (exclude dev artifacts via .dockerignore)
COPY . .

# Create data directory for run persistence
RUN mkdir -p /app/data && echo '[]' > /app/data/runs.json

# Repos are mounted at /repos — allow the app to resolve paths under it
ENV REPOS_ROOT=/repos

# Default port
ENV PORT=4200

EXPOSE 4200

# Health check — light GET against the API
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:4200/api/runs || exit 1

CMD ["node", "server.js"]
