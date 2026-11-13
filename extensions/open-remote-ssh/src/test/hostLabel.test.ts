/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import SSHDestination from '../ssh/sshDestination';
import { hostLabelSuffix } from '../hostLabel';

suite('host label', () => {

	test('names user, host and port when given, so hosts can be told apart', () => {
		assert.deepStrictEqual([
			hostLabelSuffix(new SSHDestination('box')),
			hostLabelSuffix(new SSHDestination('box', 'alice')),
			hostLabelSuffix(new SSHDestination('box', 'bob')),
			hostLabelSuffix(new SSHDestination('box', 'bob', 2222)),
			hostLabelSuffix(new SSHDestination('box', undefined, 2222)),
		], [
			'SSH: box',
			'SSH: alice@box',
			'SSH: bob@box',
			'SSH: bob@box:2222',
			'SSH: box:2222',
		]);
	});
});
