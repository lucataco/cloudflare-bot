FROM docker.io/cloudflare/sandbox:0.12.9
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY run.py /opt/workshop/run.py
