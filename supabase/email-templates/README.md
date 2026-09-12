# Havyn Supabase Email Templates

## Confirm Signup

Use `confirm-signup.html` for Supabase Auth's **Confirm signup** email body.

Suggested subject:

```text
Havyn access
```

The template uses Supabase's required `{{ .ConfirmationURL }}` variable and does not include app launch or support links.

## Confirmation Redirect

The confirmation result page is deployed with Havyn Web on Cloudflare Pages:

```text
https://havyn-web.pages.dev/verify/
```

In Supabase Auth URL settings:

- Site URL: `https://havyn-web.pages.dev/verify/`
- Redirect URL: `https://havyn-web.pages.dev/verify/`

Both Havyn Web and the desktop app send `emailRedirectTo` to this URL through `VITE_AUTH_REDIRECT_URL`. The old Render and static verification URLs remain compatibility paths for links already sent.
