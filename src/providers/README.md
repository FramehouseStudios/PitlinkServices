# providers module

Provider marketplace (identity, verification, offers). Provider principals
live in src/common/auth; live presence in src/realtime. Marketplace flows
land with Phase 1 live-provider work. Domain code here must not import
vendor SDKs (Contract Gate).
