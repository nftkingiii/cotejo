# Relayer and miner for the citation-check supplier. One image; ROLE picks which runs.
FROM ghcr.io/pokt-network/pocket-relay-miner:v0.1.0
USER root
RUN mkdir -p /keys /opt/cotejo && chown pocket:pocket /keys
COPY pocket/relayminer/relayer.yaml pocket/relayminer/miner.yaml /opt/cotejo/
COPY --chmod=0755 pocket/relayminer/entrypoint.sh /opt/cotejo/entrypoint.sh
USER pocket
EXPOSE 8080
ENTRYPOINT ["/opt/cotejo/entrypoint.sh"]
CMD []
