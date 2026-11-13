#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------
# Installs the server's remote/ dependencies for glibc Linux. Debian 11 (glibc 2.31), so that the
# native modules also load on older distributions (Ubuntu 20.04+, Debian 11+), with the official
# Node.js build (which itself needs glibc 2.28).
FROM debian:bullseye-slim
ARG NODE_VERSION
ARG NODE_ARCH
ARG NODE_SHA256
ARG PNPM_VERSION
# Debian 11 is past its end of life: deb.debian.org drops its packages while the indexes still list
# them (404s). archive.debian.org keeps a frozen, consistent copy of main, updates and security, whose
# Release files are no longer refreshed, hence Check-Valid-Until=false.
RUN rm -f /etc/apt/sources.list.d/* \
	&& printf '%s\n' \
		'deb http://archive.debian.org/debian bullseye main' \
		'deb http://archive.debian.org/debian bullseye-updates main' \
		'deb http://archive.debian.org/debian-security bullseye-security main' \
		> /etc/apt/sources.list \
	&& echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99archive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl python3 make g++ pkg-config libkrb5-dev git file \
	&& rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/node.tar.gz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" \
	&& echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
	&& tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components 1 \
	&& rm /tmp/node.tar.gz
RUN npm install -g "pnpm@${PNPM_VERSION}"
