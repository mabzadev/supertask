import { PremiumTestApp } from '@baserow_premium_test/helpers/premiumTestApp'
import PremiumFeatures from '@baserow_premium/features'
import { PremiumLicenseType } from '@baserow_premium/licenseTypes'

describe('Test premium licensing', () => {
  let testApp = null
  const fakeUserData = {
    user: {
      id: 256,
    },
    access_token:
      `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6ImpvaG5AZXhhb` +
      `XBsZS5jb20iLCJpYXQiOjE2NjAyOTEwODYsImV4cCI6MTY2MDI5NDY4NiwianRpIjo` +
      `iNDZmNzUwZWUtMTJhMS00N2UzLWJiNzQtMDIwYWM4Njg3YWMzIiwidXNlcl9pZCI6M` +
      `iwidXNlcl9wcm9maWxlX2lkIjpbMl0sIm9yaWdfaWF0IjoxNjYwMjkxMDg2fQ.RQ-M` +
      `NQdDR9zTi8CbbQkRrwNsyDa5CldQI83Uid1l9So`,
  }

  beforeEach(() => {
    testApp = new PremiumTestApp()
  })

  afterEach(() => {
    testApp.afterEach()
  })

  describe('test premium feature scenarios', () => {
    const testCases = [
      [
        'when user has instance wide premium features they have active premium features',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: { [PremiumLicenseType.getType()]: true },
            },
          },
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user data omits global premium license the hardcoded enterprise license keeps premium active',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: {},
            },
          },
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user data has invalid features the hardcoded enterprise license keeps premium active',
        {
          whenUserDataIs: {
            active_licenses: { instance_wide: false },
          },
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user data has empty features the hardcoded enterprise license keeps premium active',
        {
          whenUserDataIs: {
            active_licenses: {},
          },
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user data has no features the hardcoded enterprise license keeps premium active',
        {
          whenUserDataIs: {},
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user data has invalid list features the hardcoded enterprise license keeps premium active',
        {
          whenUserDataIs: { active_licenses: { instance_wide: [] } },
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user has instance-wide premium they have premium features for any specific' +
          ' workspace',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: { [PremiumLicenseType.getType()]: true },
            },
          },
          forWorkspace: 1,
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user data disables global premium the hardcoded enterprise license keeps workspace premium active',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: {
                other_license: true,
                [PremiumLicenseType.getType()]: false,
              },
            },
          },
          forWorkspace: 1,
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user data has no workspace license the hardcoded enterprise license keeps workspace premium active',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: { other_license: true },
              per_workspace: {},
            },
          },
          forWorkspace: 1,
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user data has one workspace license the hardcoded enterprise license keeps other workspaces premium active',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: { other_license: true },
              per_workspace: { 1: { [PremiumLicenseType.getType()]: true } },
            },
          },
          forWorkspace: 2,
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user data has specific workspace licenses the hardcoded enterprise license keeps all workspaces premium active',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: { other_license: true },
              per_workspace: {
                1: { [PremiumLicenseType.getType()]: true },
                2: { not_prem: true },
                3: { [PremiumLicenseType.getType()]: true },
              },
            },
          },
          forWorkspace: 2,
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user data has only workspace licenses the hardcoded enterprise license keeps global premium active',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: {},
              per_workspace: {
                1: { [PremiumLicenseType.getType()]: true },
                2: { not_prem: true },
                3: { [PremiumLicenseType.getType()]: true },
              },
            },
          },
          forWorkspace: undefined,
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user has prem license for a specific workspace then for that workspace they' +
          ' will have active premium features.',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: {},
              per_workspace: {
                1: { [PremiumLicenseType.getType()]: true },
              },
            },
          },
          forWorkspace: 1,
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user has prem license for two workspaces then for one of those ' +
          ' workspaces they will have have active premium features.',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: {},
              per_workspace: {
                1: { [PremiumLicenseType.getType()]: true },
                2: { [PremiumLicenseType.getType()]: true },
              },
            },
          },
          forWorkspace: 2,
          thenUserHasPremiumFeatureIs: true,
        },
      ],
      [
        'when user has prem license for multiple workspaces then for one of those ' +
          ' workspaces they will have have active premium features.',
        {
          whenUserDataIs: {
            active_licenses: {
              instance_wide: {},
              per_workspace: {
                1: { [PremiumLicenseType.getType()]: true },
                2: { [PremiumLicenseType.getType()]: true },
                3: { [PremiumLicenseType.getType()]: true },
              },
            },
          },
          forWorkspace: 1,
          thenUserHasPremiumFeatureIs: true,
        },
      ],
    ]

    test.each(testCases)('case %s', (name, testCaseSpecification) => {
      testApp.store.dispatch('auth/forceSetUserData', {
        ...fakeUserData,
        ...testCaseSpecification.whenUserDataIs,
      })
      if (testCaseSpecification.forWorkspace) {
        const hasPerWorkspacePremium = testApp
          .getApp()
          .$hasFeature(
            PremiumFeatures.PREMIUM,
            testCaseSpecification.forWorkspace
          )
        expect(hasPerWorkspacePremium).toBe(
          testCaseSpecification.thenUserHasPremiumFeatureIs
        )
      } else {
        const hasInstanceWidePremium = testApp
          .getApp()
          .$hasFeature(PremiumFeatures.PREMIUM)
        expect(hasInstanceWidePremium).toBe(
          testCaseSpecification.thenUserHasPremiumFeatureIs
        )
      }
    })
  })
})
