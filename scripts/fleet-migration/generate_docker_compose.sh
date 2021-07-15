#!/usr/bin/env bash
python3 ./scripts/compose.py start 7.14.0 \
  --no-apm-server-self-instrument \
  --with-elastic-agent \
  --elastic-agent-elasticsearch-url="http://elasticsearch:9200" \
  --with-opbeans-python \
  --with-opbeans-node \
  --with-opbeans-rum \
  --docker-compose-path - --skip-download \
  > docker-compose.yml
