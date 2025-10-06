# AI Agent Task Prompts - Originals Protocol Implementation

This directory contains **self-contained task prompts** for implementing the complete asset migration system for the Originals Protocol.

---

## 📋 Task Execution Order

Execute tasks in this order for proper dependencies:

### Phase 1: Asset Creation (Week 1)
1. **TASK_BE01_ASSET_CREATION.md** - Backend: Create assets with DID integration (6-8 hours)
2. **TASK_FE01_ASSET_CREATION_UI.md** - Frontend: Asset creation UI (4-6 hours)
3. **TASK_TEST01_ASSET_CREATION_TESTS.md** - Tests: Asset creation tests (3-4 hours)

### Phase 2: Publish to Web (Week 1-2)
4. **TASK_BE02_PUBLISH_TO_WEB.md** - Backend: did:peer → did:webvh migration (8-10 hours)
5. **TASK_FE02_PUBLISH_TO_WEB_UI.md** - Frontend: Publish button and UI (4-5 hours)
6. **TASK_TEST02_PUBLISH_TESTS.md** - Tests: Publish flow tests (3-4 hours)

### Phase 3: Inscribe on Bitcoin (Week 2-3)
7. **TASK_BE03_INSCRIBE_ON_BITCOIN.md** - Backend: did:webvh → did:btco inscription (10-12 hours)
8. **TASK_FE03_INSCRIBE_UI.md** - Frontend: Inscribe with fee estimation (5-6 hours)
9. **TASK_TEST03_INSCRIBE_TESTS.md** - Tests: Inscription tests (3-4 hours)

### Phase 4: Transfer Ownership (Week 3)
10. **TASK_BE04_TRANSFER_OWNERSHIP.md** - Backend: Asset transfer (6-8 hours)
11. **TASK_FE04_TRANSFER_UI.md** - Frontend: Transfer UI (4-5 hours)
12. **TASK_TEST04_TRANSFER_TESTS.md** - Tests: Transfer tests (3-4 hours)

**Total Estimated Time**: 60-80 hours

---

## 🚀 How to Use These Prompts

### For AI Agents:
1. Read the task file completely
2. Follow the "Context Files to Read" section first
3. Implement according to the requirements
4. Validate against the checklist
5. Test manually as described
6. Mark complete when all criteria met

### For Developers:
1. Assign one task file per agent/developer
2. Tasks are self-contained with all necessary context
3. Each task includes:
   - Objective
   - Context files to read
   - Step-by-step implementation
   - Validation checklist
   - Testing instructions
   - Success criteria

---

## ✅ Completed Tasks

### Foundation (Complete)
- ✅ Database schema migration for layer tracking
- ✅ LayerBadge and LayerFilter components
- ✅ Dashboard integration with layer filtering
- ✅ Type safety improvements (AssetLayer type)

---

## 📊 Current Progress

**Tasks Completed**: 3/12 (25%)  
**Phase 1 Status**: 0/3 tasks  
**Overall Progress**: ~8% complete

---

## 🎯 Current Status

**Database Layer**: ✅ Ready  
**UI Components**: ✅ Ready  
**SDK Integration**: ⏳ In Progress (BE-01)

**Next Task**: TASK_BE01_ASSET_CREATION.md

---

## 📁 File Structure

```
/workspace/
├── AGENT_TASKS_README.md          ← You are here
├── TASK_BE01_ASSET_CREATION.md
├── TASK_FE01_ASSET_CREATION_UI.md
├── TASK_TEST01_ASSET_CREATION_TESTS.md
├── TASK_BE02_PUBLISH_TO_WEB.md
├── TASK_FE02_PUBLISH_TO_WEB_UI.md
├── TASK_TEST02_PUBLISH_TESTS.md
├── TASK_BE03_INSCRIBE_ON_BITCOIN.md
├── TASK_FE03_INSCRIBE_UI.md
├── TASK_TEST03_INSCRIBE_TESTS.md
├── TASK_BE04_TRANSFER_OWNERSHIP.md
├── TASK_FE04_TRANSFER_UI.md
└── TASK_TEST04_TRANSFER_TESTS.md
```

---

## 🔑 Key Concepts

### Three-Layer Protocol
1. **did:peer** (Private) - Local, offline, private
2. **did:webvh** (Web) - Published via HTTPS, publicly resolvable
3. **did:btco** (Bitcoin) - Inscribed on Bitcoin, immutable

### Migration Flow
```
Create Asset (did:peer)
    ↓
Publish to Web (did:webvh)
    ↓
Inscribe on Bitcoin (did:btco)
```

Transfer can happen at any layer.

---

## 🧪 Testing Strategy

Each phase includes:
- **Backend tests**: API endpoint validation
- **Frontend tests**: Component and UI testing
- **E2E tests**: Full flow integration testing

Aim for >80% code coverage on new features.

---

## 📝 Notes

- All tasks are **self-contained** - no need to reference other planning docs
- Each task includes **complete context** and implementation steps
- Tasks can be assigned to different agents in parallel within a phase
- Follow the dependency order (don't start FE-01 until BE-01 is done)
- Test tasks depend on both BE and FE tasks being complete

---

## 🆘 Getting Help

If a task is unclear or blocked:
1. Re-read the "Context Files to Read" section
2. Check the reference implementation mentioned
3. Review the e2e test: `tests/integration/CompleteLifecycle.e2e.test.ts`
4. Ask for clarification with specific questions

---

## 🎉 Success Metrics

System is complete when:
- ✅ All 12 tasks marked complete
- ✅ All tests passing
- ✅ E2E flows work for all operations
- ✅ Manual testing confirms all features
- ✅ Documentation updated
- ✅ Code coverage >80%

---

**Ready to start? Begin with TASK_BE01_ASSET_CREATION.md**
