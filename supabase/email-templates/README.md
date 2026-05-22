# Havyn Supabase Email Templates

## Confirm Signup

Use `confirm-signup.html` for Supabase Auth's **Confirm signup** email body.

Suggested subject:

```text
Havyn access
```

The template uses Supabase's required `{{ .ConfirmationURL }}` variable and does not include app launch or support links.

## Free Redirect Setup

Use Render's free static site for the confirmation result page:

```text
https://havyn-verify.onrender.com
```

In Supabase Auth URL settings:

- Site URL: `https://havyn-verify.onrender.com`
- Redirect URL: `https://havyn-verify.onrender.com`

The desktop app also sends `emailRedirectTo` to this same URL through `VITE_AUTH_REDIRECT_URL`.
