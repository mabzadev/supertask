import ViewsContext from '@supertask/modules/database/components/view/ViewsContext'
import PaidFeaturesModal from '@supertask_premium/components/PaidFeaturesModal'
import { PremiumTestApp } from '@supertask_premium_test/helpers/premiumTestApp'
import flushPromises from 'flush-promises'
import CreateViewModal from '@supertask/modules/database/components/view/CreateViewModal'

async function openViewContextAndClickOnCreateKanbanView(
  testApp,
  { userWorkspaceId = 1 } = {}
) {
  const viewsContext = await testApp.mount(ViewsContext, {
    props: {
      database: { workspace: { id: userWorkspaceId } },
      views: [],
      table: {},
      readOnly: false,
    },
  })

  await viewsContext.vm.show(viewsContext)
  // Show runs some extra code in a nextTick so flush them now.
  await flushPromises()

  const paidFeaturesModal = viewsContext.findComponent(PaidFeaturesModal)
  expect(paidFeaturesModal.isVisible()).toBe(false)

  const kanbanLink = viewsContext
    .findAll('.select__footer-create-link')
    .filter((node) => node.text() === 'premium.viewType.kanban')
    .at(0)
  await kanbanLink.trigger('click')
  await flushPromises()
  return viewsContext
}

describe('Premium View Type Component Tests', () => {
  let testApp = null

  beforeEach(() => {
    testApp = new PremiumTestApp()
  })

  afterEach(() => testApp.afterEach())

  test('Hardcoded enterprise license can create Kanban view without explicit user premium data', async () => {
    const viewsContext =
      await openViewContextAndClickOnCreateKanbanView(testApp)
    const visibleCreateViewModals = viewsContext
      .findAllComponents(CreateViewModal)
      .filter((m) => m.isVisible())
    expect(visibleCreateViewModals).toHaveLength(1)
    expect(viewsContext.findComponent(PaidFeaturesModal).isVisible()).toBe(
      false
    )
  })
  test('User with global premium features can create Kanban view', async () => {
    testApp.giveCurrentUserGlobalPremiumFeatures()

    const viewsContext =
      await openViewContextAndClickOnCreateKanbanView(testApp)

    const visibleCreateViewModals = viewsContext
      .findAllComponents(CreateViewModal)
      .filter((m) => m.isVisible())
    expect(visibleCreateViewModals).toHaveLength(1)
    expect(viewsContext.findComponent(PaidFeaturesModal).isVisible()).toBe(
      false
    )
  })
})
