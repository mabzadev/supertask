import { defineNuxtPlugin } from '#app'

import { LocalSupertaskIntegrationType } from '@supertask/modules/integrations/localSupertask/integrationTypes'
import { SMTPIntegrationType } from '@supertask/modules/integrations/core/integrationTypes'
import { AIIntegrationType } from '@supertask/modules/integrations/ai/integrationTypes'
import {
  LocalSupertaskGetRowServiceType,
  LocalSupertaskListRowsServiceType,
  LocalSupertaskAggregateRowsServiceType,
  LocalSupertaskCreateRowWorkflowServiceType,
  LocalSupertaskDeleteRowWorkflowServiceType,
  LocalSupertaskUpdateRowWorkflowServiceType,
  LocalSupertaskRowsCreatedTriggerServiceType,
  LocalSupertaskRowsUpdatedTriggerServiceType,
  LocalSupertaskRowsDeletedTriggerServiceType,
} from '@supertask/modules/integrations/localSupertask/serviceTypes'
import {
  CoreHTTPRequestServiceType,
  PeriodicTriggerServiceType,
  CoreRouterServiceType,
  CoreSMTPEmailServiceType,
  CoreHTTPTriggerServiceType,
  CoreIteratorServiceType,
} from '@supertask/modules/integrations/core/serviceTypes'
import { AIAgentServiceType } from '@supertask/modules/integrations/ai/serviceTypes'

export default defineNuxtPlugin({
  dependsOn: ['core'],
  setup(nuxtApp) {
    const { $registry } = nuxtApp

    const context = { app: nuxtApp }

    $registry.register('integration', new LocalSupertaskIntegrationType(context))
    $registry.register('integration', new SMTPIntegrationType(context))
    $registry.register('integration', new AIIntegrationType(context))

    $registry.register('service', new LocalSupertaskGetRowServiceType(context))
    $registry.register('service', new LocalSupertaskListRowsServiceType(context))
    $registry.register(
      'service',
      new LocalSupertaskAggregateRowsServiceType(context)
    )
    $registry.register(
      'service',
      new LocalSupertaskCreateRowWorkflowServiceType(context)
    )
    $registry.register(
      'service',
      new LocalSupertaskUpdateRowWorkflowServiceType(context)
    )
    $registry.register(
      'service',
      new LocalSupertaskDeleteRowWorkflowServiceType(context)
    )
    $registry.register('service', new CoreHTTPRequestServiceType(context))
    $registry.register('service', new CoreSMTPEmailServiceType(context))
    $registry.register('service', new CoreRouterServiceType(context))
    $registry.register('service', new CoreHTTPTriggerServiceType(context))
    $registry.register('service', new CoreIteratorServiceType(context))
    $registry.register('service', new AIAgentServiceType(context))
    $registry.register('service', new PeriodicTriggerServiceType(context))
    $registry.register(
      'service',
      new LocalSupertaskRowsCreatedTriggerServiceType(context)
    )
    $registry.register(
      'service',
      new LocalSupertaskRowsUpdatedTriggerServiceType(context)
    )
    $registry.register(
      'service',
      new LocalSupertaskRowsDeletedTriggerServiceType(context)
    )
  },
})
