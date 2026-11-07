import { defineNuxtPlugin } from '#app'
import {
  GeneralAutomationSettingsType,
  IntegrationsAutomationSettingsType,
} from '@supertask/modules/automation/automationSettingTypes'

import { AutomationApplicationType } from '@supertask/modules/automation/applicationTypes'
import automationApplicationStore from '@supertask/modules/automation/store/automationApplication'
import automationWorkflowStore from '@supertask/modules/automation/store/automationWorkflow'
import automationWorkflowNodeStore from '@supertask/modules/automation/store/automationWorkflowNode'
import automationHistoryStore from '@supertask/modules/automation/store/automationHistory'
import {
  LocalSupertaskCreateRowActionNodeType,
  LocalSupertaskUpdateRowActionNodeType,
  LocalSupertaskDeleteRowActionNodeType,
  LocalSupertaskGetRowActionNodeType,
  LocalSupertaskListRowsActionNodeType,
  LocalSupertaskRowsCreatedTriggerNodeType,
  LocalSupertaskRowsUpdatedTriggerNodeType,
  LocalSupertaskRowsDeletedTriggerNodeType,
  CoreHTTPTriggerNodeType,
  LocalSupertaskAggregateRowsActionNodeType,
  CoreHttpRequestNodeType,
  CoreIteratorNodeType,
  CoreSMTPEmailNodeType,
  CoreRouterNodeType,
  CorePeriodicTriggerNodeType,
  AIAgentActionNodeType,
} from '@supertask/modules/automation/nodeTypes'
import {
  DuplicateAutomationWorkflowJobType,
  PublishAutomationWorkflowJobType,
} from '@supertask/modules/automation/jobTypes'
import {
  HistoryEditorSidePanelType,
  NodeEditorSidePanelType,
} from '@supertask/modules/automation/editorSidePanelTypes'
import { AutomationSearchType } from '@supertask/modules/automation/searchTypes'
import { searchTypeRegistry } from '@supertask/modules/core/search/types/registry'
import { AutomationGuidedTourType } from '@supertask/modules/automation/guidedTourTypes'
import {
  PreviousNodeDataProviderType,
  CurrentIterationDataProviderType,
} from '@supertask/modules/automation/dataProviderTypes'

export default defineNuxtPlugin({
  name: 'automation',
  dependsOn: ['core', 'store'],
  setup(nuxtApp) {
    const { $registry, $store, $clientErrorMap, $i18n } = nuxtApp

    const context = { app: nuxtApp }

    $clientErrorMap.setError(
      'ERROR_AUTOMATION_WORKFLOW_NAME_NOT_UNIQUE',
      $i18n.t('automationWorkflowErrors.errorNameNotUnique'),
      $i18n.t('automationWorkflowErrors.errorNameNotUniqueDescription')
    )

    // Register stores
    $store.registerModuleNuxtSafe(
      'automationApplication',
      automationApplicationStore
    )
    $store.registerModuleNuxtSafe('automationWorkflow', automationWorkflowStore)
    $store.registerModuleNuxtSafe(
      'automationWorkflowNode',
      automationWorkflowNodeStore
    )
    $store.registerModuleNuxtSafe('automationHistory', automationHistoryStore)
    $store.registerModuleNuxtSafe(
      'template/automationApplication',
      automationApplicationStore
    )

    $registry.registerNamespace('automationDataProvider')
    $registry.registerNamespace('node')
    $registry.registerNamespace('editorSidePanel')

    // Automation data providers
    $registry.register('application', new AutomationApplicationType(context))
    $registry.register(
      'automationDataProvider',
      new PreviousNodeDataProviderType(context)
    )
    $registry.register(
      'automationDataProvider',
      new CurrentIterationDataProviderType(context)
    )

    // Automation node types
    $registry.register(
      'node',
      new LocalSupertaskRowsCreatedTriggerNodeType(context)
    )
    $registry.register(
      'node',
      new LocalSupertaskRowsUpdatedTriggerNodeType(context)
    )
    $registry.register(
      'node',
      new LocalSupertaskRowsDeletedTriggerNodeType(context)
    )
    $registry.register('node', new CoreHTTPTriggerNodeType(context))
    $registry.register('node', new LocalSupertaskCreateRowActionNodeType(context))
    $registry.register('node', new LocalSupertaskUpdateRowActionNodeType(context))
    $registry.register('node', new CoreHttpRequestNodeType(context))
    $registry.register('node', new CoreSMTPEmailNodeType(context))
    $registry.register('node', new CoreRouterNodeType(context))
    $registry.register('node', new CoreIteratorNodeType(context))
    $registry.register('node', new LocalSupertaskDeleteRowActionNodeType(context))
    $registry.register('node', new LocalSupertaskGetRowActionNodeType(context))
    $registry.register('node', new LocalSupertaskListRowsActionNodeType(context))
    $registry.register(
      'node',
      new LocalSupertaskAggregateRowsActionNodeType(context)
    )
    $registry.register('node', new CorePeriodicTriggerNodeType(context))
    $registry.register('node', new AIAgentActionNodeType(context))

    // Automation job types
    $registry.register('job', new DuplicateAutomationWorkflowJobType(context))
    $registry.register('job', new PublishAutomationWorkflowJobType(context))

    // Automation settings
    $registry.registerNamespace('automationSettings')
    $registry.register(
      'automationSettings',
      new GeneralAutomationSettingsType(context)
    )
    $registry.register(
      'automationSettings',
      new IntegrationsAutomationSettingsType(context)
    )

    // Automation editor side panels
    $registry.register('editorSidePanel', new NodeEditorSidePanelType(context))
    $registry.register(
      'editorSidePanel',
      new HistoryEditorSidePanelType(context)
    )

    // Automation search type
    searchTypeRegistry.register(new AutomationSearchType(context))

    // Automation guided tour
    $registry.register('guidedTour', new AutomationGuidedTourType(context))
  },
})
