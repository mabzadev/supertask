import { shallowMount } from '@vue/test-utils'
import flushPromises from 'flush-promises'
import AccountAccessSettings from '@supertask/modules/core/components/admin/settings/AccountAccessSettings'

const service = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  searchUsers: vi.fn(),
}))

vi.mock('@supertask/modules/core/services/admin/accountAccess', () => ({
  default: () => service,
}))

function mountSettings() {
  return shallowMount(AccountAccessSettings, {
    global: {
      mocks: {
        $client: {},
        $t: (key) => key,
      },
      stubs: {
        Error: true,
        Badge: true,
        FormInput: true,
        Button: true,
        Checkbox: true,
      },
    },
  })
}

describe('AccountAccessSettings', () => {
  beforeEach(() => {
    service.get.mockReset()
    service.update.mockReset()
    service.searchUsers.mockReset()
    service.get.mockResolvedValue({
      data: {
        policy: 'invitation_allowlist',
        allowed_emails: [],
        allowed_domains: [],
        account_creators: [
          {
            id: 1,
            email: 'admin@supertask.test',
            name: 'Admin',
            is_staff: true,
            selected: false,
          },
        ],
      },
    })
  })

  it('warns when the allowlist is empty and keeps staff always authorized', async () => {
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.text()).toContain('settings.accountAccess.emptyWarning')
    expect(wrapper.vm.visibleUsers[0]).toMatchObject({
      email: 'admin@supertask.test',
      is_staff: true,
    })
    expect(wrapper.vm.selectedCreatorIds).toEqual([])
  })

  it('normalizes local rules and saves selected account managers', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    wrapper.vm.mergeUsers([
      {
        id: 2,
        email: 'manager@supertask.test',
        name: 'Manager',
        is_staff: false,
        is_active: true,
      },
    ])
    wrapper.vm.emailDraft = ' Person@Example.com '
    wrapper.vm.addRule('email')
    wrapper.vm.domainDraft = '@Example.com'
    wrapper.vm.addRule('domain')
    wrapper.vm.setCreator(2, true)

    service.update.mockResolvedValue({
      data: {
        allowed_emails: ['person@example.com'],
        allowed_domains: ['example.com'],
        account_creators: [
          {
            id: 2,
            email: 'manager@supertask.test',
            name: 'Manager',
            is_staff: false,
            selected: true,
          },
        ],
      },
    })
    await wrapper.vm.save()

    expect(service.update).toHaveBeenCalledWith({
      allowed_emails: ['person@example.com'],
      allowed_domains: ['example.com'],
      creator_user_ids: [2],
    })
    expect(wrapper.vm.saved).toBe(true)
  })
})
