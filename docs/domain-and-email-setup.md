# SwiftCollab domain and invitation email setup

Use separate hostnames for the web application and API:

- `app.<your-domain>` -> React/Vite frontend
- `api.<your-domain>` -> Express backend
- `invite@<your-domain>` -> invitation sender

Do not put production secrets in committed `.env` files. Configure them in the hosting provider's environment-variable dashboard.

## Frontend

```env
VITE_API_URL=https://api.<your-domain>
VITE_APP_NAME=SwiftCollab
```

`VITE_API_URL` is a build-time setting. Rebuild the frontend after changing it.

## Backend

```env
NODE_ENV=production
APP_URL=https://app.<your-domain>
FRONTEND_URL=https://app.<your-domain>
CORS_ALLOWED_ORIGINS=https://app.<your-domain>
JWT_SECRET=<at-least-32-random-bytes>
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
COOKIE_DOMAIN=.<your-domain>
RESEND_API_KEY=<provider-api-key>
EMAIL_FROM=SwiftCollab <invite@<your-domain>>
```

If the frontend and API are hosted on unrelated parent domains, set `COOKIE_SAME_SITE=none`, keep `COOKIE_SECURE=true`, and leave `COOKIE_DOMAIN` empty. Prefer same-parent-domain hosting because it is simpler and safer.

## DNS and email

1. Point the `app` hostname to the frontend host using the record it provides.
2. Point the `api` hostname to the backend host using the record it provides.
3. Add the SPF and DKIM records supplied by the transactional-email provider.
4. Add a DMARC TXT record in monitoring mode first, then strengthen the policy after delivery is verified.
5. Verify the sender domain with the email provider before enabling invitations in production.
6. Send an invitation to a test address and confirm that the link starts with the production `APP_URL`.

The exact DNS values depend on the hosting and email providers. Record names and targets should be copied from those dashboards rather than guessed.
