#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------
# Runs the repository install and the gulp `vscode-reh-*` task that packages a server.
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm
ARG PNPM_VERSION
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ pkg-config libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev git file \
	&& rm -rf /var/lib/apt/lists/*
RUN npm install -g "pnpm@${PNPM_VERSION}"
