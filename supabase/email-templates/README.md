# Havyn Supabase Email Templates

## Confirm Signup

Use `confirm-signup.html` for Supabase Auth's **Confirm signup** email body.

Suggested subject:

```text
Verify your Havyn account
```

The template uses Supabase's required `{{ .ConfirmationURL }}` variable and does not include app launch or support links.
