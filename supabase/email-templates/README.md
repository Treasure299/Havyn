# Havyn Supabase Email Templates

## Confirm Signup

Use `confirm-signup.html` for Supabase Auth's **Confirm signup** email body.

Suggested subject:

```text
Havyn access
```

The template uses Supabase's required `{{ .ConfirmationURL }}` variable and does not include app launch or support links.

## Free Redirect Setup

Use the existing free Render server for the confirmation result page:

```text
https://havyn-socket-server.onrender.com/verify
```

In Supabase Auth URL settings:

- Site URL: `https://havyn-socket-server.onrender.com/verify`
- Redirect URL: `https://havyn-socket-server.onrender.com/verify`

The desktop app also sends `emailRedirectTo` to this same URL through `VITE_AUTH_REDIRECT_URL`.
