import type { Env } from "../types/env";

// Email service using Cloudflare Email Workers or external SMTP API
// Falls back to console.log in dev if SMTP not configured

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function sendEmail(env: Env, payload: EmailPayload): Promise<void> {
  if (!env.SMTP_HOST) {
    console.log(`[EMAIL DEV] To: ${payload.to}, Subject: ${payload.subject}`);
    return;
  }

  // Use Mailgun API or any HTTP-based email service
  // Example: Mailgun
  const response = await fetch(`https://api.mailgun.net/v3/${env.SMTP_HOST}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`api:${env.SMTP_PASS}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      from: env.SMTP_FROM || `noreply@${env.SMTP_HOST}`,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[EMAIL ERROR] Failed to send email: ${err}`);
    // Don't throw — email failures shouldn't break the API
  }
}

function tokenUrl(baseUrl: string, token: string): string {
  const cleanBase = baseUrl.replace(/\/$/, "");
  return `${cleanBase}/${encodeURIComponent(token)}`;
}

export async function sendPasswordResetEmail(
  env: Env,
  email: string,
  firstName: string,
  token: string,
  publicUrl: string
): Promise<void> {
  const resetUrl = tokenUrl(publicUrl, token);

  await sendEmail(env, {
    to: email,
    subject: "Reset your Supertask password",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Reset your password</h2>
        <p>Hi ${firstName || "there"},</p>
        <p>We received a request to reset your password. Click the link below to choose a new password:</p>
        <p><a href="${resetUrl}" style="background: #4b6cc1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Reset Password</a></p>
        <p>This link expires in 24 hours.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
    text: `Reset your password by visiting: ${resetUrl}\n\nThis link expires in 24 hours.`,
  });
}

export async function sendEmailVerificationEmail(
  env: Env,
  email: string,
  firstName: string,
  token: string,
  publicUrl: string
): Promise<void> {
  const verifyUrl = tokenUrl(publicUrl, token);

  await sendEmail(env, {
    to: email,
    subject: "Verify your email address",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Verify your email</h2>
        <p>Hi ${firstName || "there"},</p>
        <p>Please verify your email address by clicking the link below:</p>
        <p><a href="${verifyUrl}" style="background: #4b6cc1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Verify Email</a></p>
      </div>
    `,
    text: `Verify your email by visiting: ${verifyUrl}`,
  });
}

export async function sendChangeEmailConfirmationEmail(
  env: Env,
  email: string,
  firstName: string,
  token: string,
  baseUrl: string
): Promise<void> {
  const changeUrl = tokenUrl(baseUrl, token);

  await sendEmail(env, {
    to: email,
    subject: "Confirm your new email address",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Confirm your email change</h2>
        <p>Hi ${firstName || "there"},</p>
        <p>Click the link below to confirm this as your new Supertask email address:</p>
        <p><a href="${changeUrl}" style="background: #4b6cc1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Change Email</a></p>
        <p>This link expires in 24 hours.</p>
      </div>
    `,
    text: `Confirm your new email address by visiting: ${changeUrl}\n\nThis link expires in 24 hours.`,
  });
}

export async function sendWorkspaceInvitationEmail(
  env: Env,
  inviteeEmail: string,
  inviterName: string,
  workspaceName: string,
  token: string,
  publicUrl: string
): Promise<void> {
  const acceptUrl = `${publicUrl}/workspace-invitation/${token}`;

  await sendEmail(env, {
    to: inviteeEmail,
    subject: `${inviterName} invited you to join ${workspaceName} on Supertask`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>You're invited!</h2>
        <p>${inviterName} has invited you to join <strong>${workspaceName}</strong> on Supertask.</p>
        <p><a href="${acceptUrl}" style="background: #4b6cc1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Accept Invitation</a></p>
      </div>
    `,
    text: `${inviterName} invited you to join ${workspaceName}. Accept at: ${acceptUrl}`,
  });
}
