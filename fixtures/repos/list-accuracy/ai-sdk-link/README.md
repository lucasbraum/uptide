# ai-sdk-link

`ai` and the `@ai-sdk/*` providers are not linked by peerDependencies (their only peer is
`zod`): they pin the same exact `@ai-sdk/provider` and `@ai-sdk/provider-utils` versions,
and their latest versions pin the same newer ones. Upgrading one alone leaves two copies.
They form one group, `ai + @ai-sdk/*`, and say why. `registry.json` holds the real npm
metadata of the installed and latest versions, recorded once; tests serve it offline.
