#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------
# Installs the server's remote/ dependencies for Alpine (musl) Linux.
ARG NODE_VERSION
FROM node:${NODE_VERSION}-alpine
ARG PNPM_VERSION
RUN apk add --no-cache bash python3 make g++ krb5-dev linux-headers git file
RUN npm install -g "pnpm@${PNPM_VERSION}"
