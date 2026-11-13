#!/usr/bin/env bash
# Runs the multi-remote integration tests: a local window whose workspace holds a local folder and
# a folder on each of two test resolver hosts, `test+a` and `test+b`, that both run on this machine.
set -e

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname $(dirname $(realpath "$0")))
else
	ROOT=$(dirname $(dirname $(readlink -f $0)))
fi

# Creates a temporary folder and prints its physical path, so that it matches what `pwd` prints in it.
make_temp_folder() {
	(cd "$(mktemp -d 2>/dev/null)" && pwd -P)
}

VSCODEUSERDATADIR=$(make_temp_folder)
VSCODECRASHDIR=$ROOT/.build/crashes
VSCODELOGSDIR=$ROOT/.build/logs/integration-tests-multi-remote
TESTRESOLVER_DATA_FOLDER=$(make_temp_folder)
WORKSPACE_FOLDER=$(make_temp_folder)
FOLDER_LOCAL=$(make_temp_folder)
FOLDER_A=$(make_temp_folder)
FOLDER_B=$(make_temp_folder)

cleanup() {
	local status=$?
	rm -rf -- "$VSCODEUSERDATADIR" "$TESTRESOLVER_DATA_FOLDER" "$WORKSPACE_FOLDER" "$FOLDER_LOCAL" "$FOLDER_A" "$FOLDER_B" || true
	if [[ $status -ne 0 ]]; then
		echo "Multi-remote integration tests failed with exit code $status." >&2
	fi
}
trap cleanup EXIT

cd $ROOT

WORKSPACE_FILE=$WORKSPACE_FOLDER/multi-remote.code-workspace
cat > "$WORKSPACE_FILE" <<EOF
{
	"folders": [
		{ "path": "$FOLDER_LOCAL" },
		{ "uri": "vscode-remote://test+a$FOLDER_A" },
		{ "uri": "vscode-remote://test+b$FOLDER_B" }
	]
}
EOF

# Figure out which Electron to use for running tests
if [ -z "$INTEGRATION_TEST_ELECTRON_PATH" ]
then
	INTEGRATION_TEST_ELECTRON_PATH="./scripts/code.sh"

	# No extra arguments when running out of sources
	EXTRA_INTEGRATION_TEST_ARGUMENTS=""

	# Load remote node
	pnpm run gulp node

	echo "Running multi-remote integration tests out of sources."
else
	export VSCODE_CLI=1
	export ELECTRON_ENABLE_LOGGING=1

	# Running from a build, we need to enable the vscode-test-resolver extension
	EXTRA_INTEGRATION_TEST_ARGUMENTS="--extensions-dir=$ROOT/extensions --enable-proposed-api=vscode.vscode-api-tests"

	echo "Running multi-remote integration tests with $INTEGRATION_TEST_ELECTRON_PATH as build."
fi

export TESTRESOLVER_DATA_FOLDER=$TESTRESOLVER_DATA_FOLDER
export TESTRESOLVER_LOGS_FOLDER=$VSCODELOGSDIR/server

# Figure out which remote server to use for running tests
if [ -z "$VSCODE_REMOTE_SERVER_PATH" ]
then
	echo "Using remote server out of sources for integration tests"
else
	echo "Using $VSCODE_REMOTE_SERVER_PATH as server path for integration tests"
	export TESTRESOLVER_INSTALL_BUILTIN_EXTENSION='ms-vscode.vscode-smoketest-check'
fi

API_TESTS_EXTRA_ARGS="--disable-telemetry --disable-experiments --skip-welcome --skip-release-notes --crash-reporter-directory=$VSCODECRASHDIR --no-cached-data --disable-updates --use-inmemory-secretstorage --disable-workspace-trust --logsPath=$VSCODELOGSDIR --user-data-dir=$VSCODEUSERDATADIR"

echo "Storing crash reports into '$VSCODECRASHDIR'."
echo "Storing log files into '$VSCODELOGSDIR'."

echo
echo "### Multi-remote API tests"
echo
"$INTEGRATION_TEST_ELECTRON_PATH" --file-uri=file://$WORKSPACE_FILE --extensionDevelopmentPath=$ROOT/extensions/vscode-api-tests --extensionTestsPath=$ROOT/extensions/vscode-api-tests/out/multiremote-tests --enable-proposed-api=vscode.vscode-test-resolver $API_TESTS_EXTRA_ARGS $EXTRA_INTEGRATION_TEST_ARGUMENTS
