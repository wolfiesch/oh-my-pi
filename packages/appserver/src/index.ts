/**
 * OMP intentionally owns no generic desktop host implementation.
 *
 * This package remains as the stable import used by the OMP CLI and authority
 * modules, but every generic server, wire, security, paging, and remote concern
 * comes from the checksum-pinned T4 artifact under vendor/t4-host.
 */
export * from "@t4-code/host-service";
