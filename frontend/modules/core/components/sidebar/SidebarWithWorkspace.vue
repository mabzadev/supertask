<template>
  <div class="sidebar__section sidebar__section--scrollable">
    <div class="sidebar__section-scrollable">
      <div
        class="sidebar__section-scrollable-inner"
        data-highlight="applications"
      >
        <ul v-if="pendingJobs[null].length" class="tree">
          <component
            :is="getPendingJobComponent(job)"
            v-for="job in pendingJobs[null]"
            :key="job.id"
            :job="job"
          >
          </component>
        </ul>
        <div v-if="flatApplications.length" class="sidebar__content-label">Contenu</div>
        <ul class="tree" data-highlight="applications-all">
          <component
            :is="getApplicationComponent(application)"
            v-for="application in flatApplications"
            :key="application.id"
            v-sortable="{
              id: application.id,
              update: orderApplications,
              handle: '[data-sortable-handle]',
              marginTop: -1.5,
              enabled: $hasPermission('workspace.order_applications', selectedWorkspace, selectedWorkspace.id),
            }"
            :application="application"
            :pending-jobs="pendingJobs[application.type] || []"
            :workspace="selectedWorkspace"
          ></component>
        </ul>
      </div>
    </div>
    <div
      v-if="
        $hasPermission(
          'workspace.create_application',
          selectedWorkspace,
          selectedWorkspace.id
        )
      "
      class="sidebar__new-wrapper sidebar__new-wrapper--separator"
      data-highlight="create-new"
    >
      <a
        ref="createApplicationContextLink"
        class="sidebar__new"
        @click="
          $refs.createApplicationContext.toggle(
            $refs.createApplicationContextLink
          )
        "
      >
        <i class="sidebar__new-icon iconoir-plus"></i>
        Ajouter
      </a>
    </div>
    <CreateApplicationContext
      ref="createApplicationContext"
      :workspace="selectedWorkspace"
    ></CreateApplicationContext>
  </div>
</template>

<script>
import { notifyIf } from '@baserow/modules/core/utils/error'
import CreateApplicationContext from '@baserow/modules/core/components/application/CreateApplicationContext'

export default {
  name: 'SidebarWithWorkspace',
  components: { CreateApplicationContext },
  props: {
    applications: {
      type: Array,
      required: true,
    },
    selectedWorkspace: {
      type: Object,
      required: true,
    },
  },
  computed: {
    /**
     * Because all the applications that belong to the user are in the store we will
     * filter on the selected workspace here.
     */
    flatApplications() {
      return this.applications
        .filter((application) => {
          if (application.workspace.id !== this.selectedWorkspace.id) return false
          const type = this.$registry.get('application', application.type)
          return type && type.isVisible(application)
        })
        .sort((a, b) => a.order - b.order)
    },
    pendingJobs() {
      const grouped = { null: [] }
      Object.values(this.$registry.getAll('application')).forEach(
        (applicationType) => {
          grouped[applicationType.getType()] = []
        }
      )
      this.$store.getters['job/getAll'].forEach((job) => {
        const jobType = this.$registry.get('job', job.type)
        if (jobType.isJobPartOfWorkspace(job, this.selectedWorkspace)) {
          grouped[jobType.getSidebarApplicationTypeLocation(job)].push(job)
        }
      })
      return grouped
    },
    canCreateApplication() {
      return this.$hasPermission(
        'workspace.create_application',
        this.selectedWorkspace,
        this.selectedWorkspace.id
      )
    },
  },
  methods: {
    getApplicationComponent(application) {
      return this.$registry
        .get('application', application.type)
        .getSidebarComponent()
    },
    getPendingJobComponent(job) {
      return this.$registry.get('job', job.type).getSidebarComponent()
    },
    async orderApplications(order, oldOrder) {
      try {
        await this.$store.dispatch('application/order', {
          workspace: this.selectedWorkspace,
          order,
          oldOrder,
        })
      } catch (error) {
        notifyIf(error, 'application')
      }
    },
  },
}
</script>

<style scoped>
.sidebar__content-label { padding: 12px 16px 6px; color: #8b8793; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.sidebar__new { margin: 7px 9px; border-radius: 9px; font-weight: 650; color: #5144c7; background: #efedff; }
.sidebar__new:hover { background: #e5e1ff; }
</style>
