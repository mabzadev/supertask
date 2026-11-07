<template>
  <Context
    ref="context"
    max-height-if-outside-viewport
    class="select"
    @shown="onShow"
  >
    <div class="select__search">
      <i class="select__search-icon iconoir-search"></i>
      <input
        ref="search"
        v-model="query"
        type="text"
        class="select__search-input"
        :placeholder="$t('action.search')"
        tabindex="0"
      />
    </div>
    <ul
      ref="dropdown"
      v-auto-overflow-scroll
      class="select__items select__items--no-max-height dashboard__user-workspaces"
    >
      <li
        v-for="workspace in filteredWorkspaces"
        :key="workspace.id"
        class="select__item"
        :class="{
          'select__item--loading':
            workspace._.loading || workspace._.additionalLoading,
          active: workspace.id === selectedWorkspace.id,
        }"
      >
        <i
          v-if="workspace.id === selectedWorkspace.id"
          class="sidebar__workspace-active-icon iconoir-check"
        ></i>
        <a class="select__item-link" @click="selectWorkspace(workspace)">
          <div class="select__item-name">
            <Avatar
              class="dashboard__user-workspace-avatar"
              :initials="$filters.nameAbbreviation(workspace.name)"
            ></Avatar>
            {{ workspace.name }}
            <span
              v-if="hasUnreadNotifications(workspace.id)"
              class="sidebar__unread-notifications-icon"
            ></span>
          </div>
        </a>
      </li>
      <li v-if="$hasPermission('create_workspace')" class="select__item">
        <a class="select__item-link" @click="$refs.createWorkspaceModal.show()">
          <div class="select__item-name">
            <ButtonIcon
              tag="a"
              size="small"
              type="secondary"
              icon="iconoir-plus"
              style="pointer-events: none"
            />
            <span>{{ $t('sidebar.addNewWorkspace') }}</span>
          </div>
        </a>
      </li>
    </ul>
    <div v-if="selectedWorkspace.id" class="sidebar__workspace-menu">
      <div class="sidebar__workspace-menu-title">{{ selectedWorkspace.name }}</div>
      <ul class="context__menu margin-bottom-0">
        <li v-if="$hasPermission('workspace.list_workspace_users', selectedWorkspace, selectedWorkspace.id)" class="context__menu-item">
          <nuxt-link class="context__menu-item-link" :to="{ name: 'settings-members', params: { workspaceId: selectedWorkspace.id } }" @click="hide()">
            <i class="context__menu-item-icon iconoir-group"></i>{{ $t('sidebar.members') }}
          </nuxt-link>
        </li>
        <li v-if="$hasPermission('workspace.create_invitation', selectedWorkspace, selectedWorkspace.id)" class="context__menu-item">
          <a class="context__menu-item-link" @click="$refs.inviteModal.show()">
            <i class="context__menu-item-icon iconoir-add-user"></i>{{ $t('sidebar.inviteOthers') }}
          </a>
        </li>
        <component
          :is="component"
          v-for="(component, index) in sidebarWorkspaceComponents"
          :key="'workspaceMenuComponent' + index"
          :workspace="selectedWorkspace"
          :right-sidebar-open="false"
          @hide="hide()"
        ></component>
        <li class="context__menu-item">
          <a class="context__menu-item-link" @click="$refs.trashModal.show()">
            <i class="context__menu-item-icon iconoir-bin"></i>{{ $t('sidebar.trash') }}
          </a>
        </li>
      </ul>
    </div>
    <div class="sidebar__user">
      <div class="sidebar__user-info">
        <span class="sidebar__user-email">
          {{ email }}
        </span>

        <component
          :is="component"
          v-for="(component, index) in highestLicenceTypeBadge"
          :key="index"
          class="sidebar__user-license"
        ></component>
      </div>

      <ul class="context__menu margin-bottom-0">
        <li v-if="isStaff" class="context__menu-item">
          <a class="context__menu-item-link" @click="admin">
            <i class="context__menu-item-icon iconoir-settings"></i>
            {{ $t('sidebar.adminTools') }}
          </a>
        </li>

        <li class="context__menu-item">
          <a
            class="context__menu-item-link"
            @click="$refs.settingsModal.show()"
          >
            <i class="context__menu-item-icon iconoir-user-circle"></i>
            {{ $t('sidebar.settings') }}
          </a>
          <SettingsModal ref="settingsModal"></SettingsModal>
        </li>

        <component
          :is="component"
          v-for="(component, index) in sidebarUserContextComponents"
          :key="'sidebarUserContextComponent' + index"
          @hide="hide()"
        ></component>

        <li
          class="context__menu-item context__menu-item--with-separator margin-bottom-0"
        >
          <a
            class="context__menu-item-link"
            :class="{ 'context__menu-item-link--loading': logoffLoading }"
            @click="logoff()"
          >
            <i class="context__menu-item-icon iconoir-log-out"></i>
            {{ $t('sidebar.logoff') }}
          </a>
        </li>
      </ul>
    </div>
    <CreateWorkspaceModal
      ref="createWorkspaceModal"
      @created="hide()"
    ></CreateWorkspaceModal>
    <WorkspaceMemberInviteModal ref="inviteModal" :workspace="selectedWorkspace" @invite-submitted="openInvitations" />
    <TrashModal ref="trashModal" :initial-workspace="selectedWorkspace" />
  </Context>
</template>

<script>
import { mapGetters } from 'vuex'

import { logoutAndRedirectToLogin } from '@supertask/modules/core/utils/auth'
import context from '@supertask/modules/core/mixins/context'
import SettingsModal from '@supertask/modules/core/components/settings/SettingsModal'
import CreateWorkspaceModal from '@supertask/modules/core/components/workspace/CreateWorkspaceModal'
import WorkspaceMemberInviteModal from '@supertask/modules/core/components/workspace/WorkspaceMemberInviteModal'
import TrashModal from '@supertask/modules/core/components/trash/TrashModal'
import { escapeRegExp } from '@supertask/modules/core/utils/string'
import { pageFinished } from '@supertask/modules/core/utils/routing'
import { nextTick } from '#imports'

export default {
  name: 'SidebarUserContext',
  components: { SettingsModal, CreateWorkspaceModal, WorkspaceMemberInviteModal, TrashModal },
  mixins: [context],
  props: {
    workspaces: {
      type: Array,
      required: true,
    },
    selectedWorkspace: {
      type: Object,
      required: true,
    },
  },
  emits: ['toggle-admin'],
  data() {
    return {
      logoffLoading: false,
      query: '',
    }
  },
  computed: {
    highestLicenceTypeBadge() {
      return Object.values(this.$registry.getAll('plugin'))
        .map((plugin) => plugin.getHighestLicenseTypeBadge())
        .filter((component) => component !== null)
    },
    adminTypes() {
      return this.$registry.getAll('admin')
    },
    sortedAdminTypes() {
      return Object.values(this.adminTypes)
        .slice()
        .sort((a, b) => a.getOrder() - b.getOrder())
    },
    sidebarUserContextComponents() {
      return Object.values(this.$registry.getAll('plugin'))
        .flatMap((plugin) =>
          plugin.getUserContextComponents(this.selectedWorkspace)
        )
        .filter((component) => component !== null)
    },
    sidebarWorkspaceComponents() {
      return Object.values(this.$registry.getAll('plugin'))
        .flatMap((plugin) => plugin.getSidebarWorkspaceComponents(this.selectedWorkspace))
        .filter((component) => component !== null)
    },
    filteredWorkspaces() {
      let workspaces = this.workspaces
      const regex = new RegExp('(' + escapeRegExp(this.query) + ')', 'i')
      if (this.query) {
        workspaces = workspaces.filter((workspace) => {
          return workspace.name.match(regex)
        })
      }
      return workspaces
    },
    ...mapGetters({
      isStaff: 'auth/isStaff',
      name: 'auth/getName',
      email: 'auth/getUsername',
    }),
  },
  methods: {
    onShow() {
      this.query = ''
      this.$nextTick(() => {
        this.$refs.search.focus()
      })
    },
    async logoff() {
      this.logoffLoading = true
      await logoutAndRedirectToLogin(
        this.$router,
        this.$store,
        false,
        false,
        true
      )
    },
    async admin() {
      this.hide()
      await this.$nextTick()

      this.$emit('toggle-admin', true)
      const activatedAdminTypes = this.sortedAdminTypes.filter(
        (adminType) => !adminType.isDeactivated()
      )
      try {
        await this.$router.push({ name: activatedAdminTypes[0].routeName })
        await pageFinished()
        await nextTick()
      } catch {}
    },
    hasUnreadNotifications(workspaceId) {
      return this.$store.getters['notification/workspaceHasUnread'](workspaceId)
    },
    async selectWorkspace(workspace) {
      if (workspace._.selected) {
        return
      }
      await this.$store.dispatch('workspace/select', workspace)
      await this.$router.push({
        name: 'workspace',
        params: { workspaceId: workspace.id },
      })
      await pageFinished()
      await nextTick()
      this.hide()
    },
    async openInvitations() {
      this.hide()
      if (this.$route.name !== 'settings-invites') {
        await this.$router.push({ name: 'settings-invites', params: { workspaceId: this.selectedWorkspace.id } })
      }
    },
  },
}
</script>

<style scoped>
.sidebar__workspace-menu { padding: 7px 0; border-top: 1px solid #e8e6ec; border-bottom: 1px solid #e8e6ec; }
.sidebar__workspace-menu-title { padding: 5px 16px 7px; color: #8c8792; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
</style>
