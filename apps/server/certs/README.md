# Database CA certificate

`supabase-prod-ca-2021.crt` is Supabase's public **Supabase Root 2021 CA** used to authenticate PostgreSQL and Session Pooler endpoints.

- Source: `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`
- SHA-256: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`
- Certificate expiry: 2031-04-26
- Supabase guidance: https://supabase.com/docs/guides/platform/ssl-enforcement

Deployments may override this file with `PGSSLROOTCERT=/absolute/path/to/provider-root-ca.crt`.
