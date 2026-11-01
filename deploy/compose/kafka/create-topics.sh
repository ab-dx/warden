#!/bin/bash
set -euo pipefail
bin=/opt/kafka/bin
grep -vE '^\s*(#|$)' /init/topics.txt | while read -r name partitions; do
  "$bin/kafka-topics.sh" --bootstrap-server kafka:9092 --create --if-not-exists \
    --topic "$name" --partitions "$partitions" --replication-factor 1
done
"$bin/kafka-topics.sh" --bootstrap-server kafka:9092 --list
