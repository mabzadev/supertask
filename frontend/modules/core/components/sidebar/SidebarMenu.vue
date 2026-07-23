<template>
  <div class="sidebar__section" ph-autocapture="sidebar" data-highlight="menu">
    <ul class="tree">
      <SidebarSearch
        :selected-workspace="selectedWorkspace"
        @open-workspace-search="openWorkspaceSearch"
      />
      <nuxt-link
        v-slot="{ href, navigate, isExactActive }"
        custom
        :to="{
          name: 'workspace',
          params: {
            workspaceId: selectedWorkspace.id,
          },
        }"
      >
        <li
          class="tree__item"
          :class="{
            active: isExactActive,
          }"
        >
          <div class="tree__action sidebar__action">
            <a :href="href" class="tree__link" @click="navigate">
              <i class="tree__icon iconoir-home-simple"></i>
              <span class="tree__link-text">
                <span class="sidebar__item-name">{{ $t('sidebar.home') }}</span>
              </span>
            </a>
          </div>
        </li>
      </nuxt-link>

      <li class="tree__item">
        <div class="tree__action tree__action--has-counter">
          <a
            class="tree__link"
            @click="$refs.notificationPanel.toggle($event.currentTarget)"
          >
            <i class="tree__icon tree__icon--type iconoir-bell"></i>
            <span class="tree__link-text">{{
              $t('sidebar.notifications')
            }}</span>
          </a>
          <BadgeCounter
            v-show="unreadNotificationCount"
            class="tree__counter"
            :count="unreadNotificationCount"
            :limit="10"
          >
          </BadgeCounter>
        </div>
        <NotificationPanel ref="notificationPanel" />
      </li>

    </ul>
  </div>
</template>

<script>
import { mapGetters } from 'vuex'

import NotificationPanel from '@baserow/modules/core/components/NotificationPanel'
import BadgeCounter from '@baserow/modules/core/components/BadgeCounter'
import SidebarSearch from '@baserow/modules/core/components/sidebar/SidebarSearch'

export default {
  name: 'SidebarMenu',
  components: {
    NotificationPanel,
    BadgeCounter,
    SidebarSearch,
  },
  props: {
    selectedWorkspace: {
      type: Object,
      required: true,
    },
    rightSidebarOpen: {
      type: Boolean,
      required: false,
      default: false,
    },
  },
  emits: ['open-workspace-search'],
  computed: {
    ...mapGetters({
      unreadNotificationCount: 'notification/getUnreadCount',
    }),
  },
  methods: {
    openWorkspaceSearch() {
      this.$emit('open-workspace-search')
    },
  },
}
</script>
