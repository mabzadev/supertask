<template>
  <div class="account-access">
    <Error :error="error"></Error>

    <div class="admin-settings__item">
      <div class="admin-settings__label">
        <div class="admin-settings__name">
          {{ $t('settings.accountAccess.modeTitle') }}
        </div>
        <div class="admin-settings__description">
          {{ $t('settings.accountAccess.modeDescription') }}
        </div>
      </div>
      <div class="admin-settings__control">
        <Badge color="purple" bold>
          {{ $t('settings.accountAccess.modeValue') }}
        </Badge>
      </div>
    </div>

    <div class="admin-settings__item account-access__item">
      <div class="admin-settings__label">
        <div class="admin-settings__name">
          {{ $t('settings.accountAccess.allowedEmails') }}
        </div>
        <div class="admin-settings__description">
          {{ $t('settings.accountAccess.allowedEmailsDescription') }}
        </div>
      </div>
      <div class="admin-settings__control account-access__control">
        <form class="account-access__add" @submit.prevent="addRule('email')">
          <FormInput
            v-model="emailDraft"
            :placeholder="$t('settings.accountAccess.emailPlaceholder')"
            :disabled="loading || saving"
          ></FormInput>
          <Button type="secondary" :disabled="!emailDraft || loading || saving">
            {{ $t('settings.accountAccess.add') }}
          </Button>
        </form>
        <div v-if="allowedEmails.length" class="account-access__chips">
          <span v-for="email in allowedEmails" :key="email" class="account-access__chip">
            {{ email }}
            <button type="button" :aria-label="$t('settings.accountAccess.remove')" @click="removeRule('email', email)">×</button>
          </span>
        </div>
        <div v-else class="account-access__empty">
          {{ $t('settings.accountAccess.noEmails') }}
        </div>
      </div>
    </div>

    <div class="admin-settings__item account-access__item">
      <div class="admin-settings__label">
        <div class="admin-settings__name">
          {{ $t('settings.accountAccess.allowedDomains') }}
        </div>
        <div class="admin-settings__description">
          {{ $t('settings.accountAccess.allowedDomainsDescription') }}
        </div>
      </div>
      <div class="admin-settings__control account-access__control">
        <form class="account-access__add" @submit.prevent="addRule('domain')">
          <FormInput
            v-model="domainDraft"
            :placeholder="$t('settings.accountAccess.domainPlaceholder')"
            :disabled="loading || saving"
          ></FormInput>
          <Button type="secondary" :disabled="!domainDraft || loading || saving">
            {{ $t('settings.accountAccess.add') }}
          </Button>
        </form>
        <div v-if="allowedDomains.length" class="account-access__chips">
          <span v-for="domain in allowedDomains" :key="domain" class="account-access__chip">
            @{{ domain }}
            <button type="button" :aria-label="$t('settings.accountAccess.remove')" @click="removeRule('domain', domain)">×</button>
          </span>
        </div>
        <div v-else class="account-access__empty">
          {{ $t('settings.accountAccess.noDomains') }}
        </div>
      </div>
    </div>

    <div v-if="!allowedEmails.length && !allowedDomains.length" class="account-access__warning">
      <i class="iconoir-warning-triangle"></i>
      {{ $t('settings.accountAccess.emptyWarning') }}
    </div>

    <div class="admin-settings__item account-access__item">
      <div class="admin-settings__label">
        <div class="admin-settings__name">
          {{ $t('settings.accountAccess.creators') }}
        </div>
        <div class="admin-settings__description">
          {{ $t('settings.accountAccess.creatorsDescription') }}
        </div>
      </div>
      <div class="admin-settings__control account-access__control">
        <form class="account-access__add" @submit.prevent="searchUsers">
          <FormInput
            v-model="userSearch"
            :placeholder="$t('settings.accountAccess.searchUsers')"
            :disabled="loading || saving"
          ></FormInput>
          <Button type="secondary" :loading="searching" :disabled="loading || saving">
            {{ $t('settings.accountAccess.search') }}
          </Button>
        </form>
        <div class="account-access__users">
          <div v-for="creator in visibleUsers" :key="creator.id" class="account-access__user">
            <Checkbox
              :model-value="creator.is_staff || selectedCreatorIds.includes(creator.id)"
              :disabled="creator.is_staff || saving"
              @update:model-value="setCreator(creator.id, $event)"
            ></Checkbox>
            <div>
              <strong>{{ creator.name || creator.email }}</strong>
              <div class="account-access__user-email">{{ creator.email }}</div>
            </div>
            <Badge v-if="creator.is_staff" color="green" size="small">
              {{ $t('settings.accountAccess.alwaysAuthorized') }}
            </Badge>
          </div>
          <div v-if="!visibleUsers.length && !searching" class="account-access__empty">
            {{ $t('settings.accountAccess.noCreators') }}
          </div>
        </div>
      </div>
    </div>

    <div class="account-access__footer">
      <span v-if="saved" class="account-access__saved">
        <i class="iconoir-check"></i> {{ $t('settings.accountAccess.saved') }}
      </span>
      <Button type="primary" :loading="saving" :disabled="loading" @click="save">
        {{ $t('settings.accountAccess.save') }}
      </Button>
    </div>
  </div>
</template>

<script>
import error from '@baserow/modules/core/mixins/error'
import AccountAccessService from '@baserow/modules/core/services/admin/accountAccess'

export default {
  name: 'AccountAccessSettings',
  mixins: [error],
  data() {
    return {
      loading: true,
      saving: false,
      searching: false,
      saved: false,
      emailDraft: '',
      domainDraft: '',
      userSearch: '',
      allowedEmails: [],
      allowedDomains: [],
      selectedCreatorIds: [],
      users: [],
    }
  },
  computed: {
    visibleUsers() {
      return [...this.users].sort((a, b) => {
        if (a.is_staff !== b.is_staff) return a.is_staff ? -1 : 1
        const aSelected = this.selectedCreatorIds.includes(a.id)
        const bSelected = this.selectedCreatorIds.includes(b.id)
        if (aSelected !== bSelected) return aSelected ? -1 : 1
        return String(a.email).localeCompare(String(b.email))
      })
    },
  },
  async mounted() {
    await this.load()
  },
  methods: {
    service() {
      return AccountAccessService(this.$client)
    },
    mergeUsers(users) {
      const byId = new Map(this.users.map((user) => [user.id, user]))
      for (const user of users) byId.set(user.id, { ...byId.get(user.id), ...user })
      this.users = [...byId.values()]
    },
    async load() {
      this.loading = true
      this.hideError()
      try {
        const { data } = await this.service().get()
        this.allowedEmails = [...data.allowed_emails]
        this.allowedDomains = [...data.allowed_domains]
        this.selectedCreatorIds = data.account_creators
          .filter((creator) => creator.selected && !creator.is_staff)
          .map((creator) => creator.id)
        this.mergeUsers(data.account_creators)
      } catch (error) {
        this.handleError(error, 'accountAccess')
      } finally {
        this.loading = false
      }
    },
    addRule(kind) {
      const isEmail = kind === 'email'
      let value = (isEmail ? this.emailDraft : this.domainDraft)
        .trim()
        .toLowerCase()
      if (!isEmail) value = value.replace(/^@+/, '')
      if (!value) return
      const target = isEmail ? this.allowedEmails : this.allowedDomains
      if (!target.includes(value)) target.push(value)
      target.sort()
      if (isEmail) this.emailDraft = ''
      else this.domainDraft = ''
      this.saved = false
    },
    removeRule(kind, value) {
      const target = kind === 'email' ? this.allowedEmails : this.allowedDomains
      target.splice(target.indexOf(value), 1)
      this.saved = false
    },
    setCreator(userId, selected) {
      const index = this.selectedCreatorIds.indexOf(userId)
      if (selected && index === -1) this.selectedCreatorIds.push(userId)
      if (!selected && index !== -1) this.selectedCreatorIds.splice(index, 1)
      this.saved = false
    },
    async searchUsers() {
      this.searching = true
      this.hideError()
      try {
        const { data } = await this.service().searchUsers(this.userSearch)
        this.mergeUsers((data.results || []).filter((user) => user.is_active))
      } catch (error) {
        this.handleError(error, 'accountAccess')
      } finally {
        this.searching = false
      }
    },
    async save() {
      this.saving = true
      this.saved = false
      this.hideError()
      try {
        const { data } = await this.service().update({
          allowed_emails: this.allowedEmails,
          allowed_domains: this.allowedDomains,
          creator_user_ids: this.selectedCreatorIds,
        })
        this.allowedEmails = [...data.allowed_emails]
        this.allowedDomains = [...data.allowed_domains]
        this.selectedCreatorIds = data.account_creators
          .filter((creator) => creator.selected && !creator.is_staff)
          .map((creator) => creator.id)
        this.mergeUsers(data.account_creators)
        this.saved = true
      } catch (error) {
        this.handleError(error, 'accountAccess')
      } finally {
        this.saving = false
      }
    },
  },
}
</script>

<style scoped>
.account-access__item { align-items: flex-start; }
.account-access__control { width: min(620px, 100%); }
.account-access__add { display: flex; gap: 8px; align-items: center; }
.account-access__add > :first-child { flex: 1; }
.account-access__chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.account-access__chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid #d8dced; border-radius: 999px; background: #f7f8fc; }
.account-access__chip button { border: 0; background: transparent; color: #687089; cursor: pointer; font-size: 18px; line-height: 1; }
.account-access__empty { color: #777e90; margin-top: 10px; }
.account-access__warning { display: flex; gap: 8px; margin: 12px 0; padding: 12px 14px; color: #8a4b08; background: #fff6df; border: 1px solid #f1d28a; border-radius: 8px; }
.account-access__users { margin-top: 12px; border: 1px solid #e1e4ef; border-radius: 8px; overflow: hidden; }
.account-access__user { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #eef0f6; }
.account-access__user:last-child { border-bottom: 0; }
.account-access__user > div:nth-child(2) { flex: 1; min-width: 0; }
.account-access__user-email { color: #777e90; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.account-access__footer { display: flex; justify-content: flex-end; align-items: center; gap: 12px; margin-top: 16px; }
.account-access__saved { color: #27784a; }
</style>
