const INSTANCE_LICENSES = {
  premium: true,
  advanced: true,
  enterprise_without_support: true,
  enterprise: true,
};

export function activeLicenses() {
  return {
    instance_wide: INSTANCE_LICENSES,
    per_workspace: {},
  };
}

export function serializePersonalLicense(now = new Date()) {
  const validFrom = new Date("2020-01-01T00:00:00.000Z").toISOString();
  const validThrough = new Date(
    Math.max(now.getTime(), Date.now()) + 100 * 365 * 24 * 60 * 60 * 1000
  ).toISOString();

  return {
    id: 1,
    license_id: "supertask-personal-enterprise",
    product_code: "enterprise",
    is_active: true,
    valid_from: validFrom,
    valid_through: validThrough,
    last_check: now.toISOString(),
    seats: 1000000,
    seats_taken: 0,
    application_users: 1000000,
    application_users_taken: 0,
    issued_to_name: "Supertask Personal",
    issued_to_email: "admin@supertask.local",
    seats_manually_assigned: false,
    trial: false,
  };
}
