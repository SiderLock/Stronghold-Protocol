"""Run with the extractor environment: python tools/local-extract/test_fx.py."""
import unittest

from fx import mode_aura_uses


class ModeAuraTests(unittest.TestCase):
    def test_carriers_lifetimes_and_real_template_actions(self):
        def buff(key, effect):
            return {'buffKey': key, 'templateKey': key, 'overrideEffectKey': effect,
                    'lifeTimeType': 2, 'triggerInterval': 2}

        fields = {'_buffs': [buff('heal', 'Heal_Fx')],
                  '_passiveBuffs': [buff('collect', 'Collect_Fx'), buff('range', 'Range_Fx')]}
        templates = {'collect': {'effect': None, 'graph': [
            ['ON_BUFF_TRIGGER', 'CreateEffect', '_effectKey', 'burst_fx']]}}
        uses = mode_aura_uses('AuraAbility', fields, 'Modes/S3/Body/AuraHeal', templates)
        by_key = {u['keys'][0]: u for u in uses}
        self.assertEqual(set(by_key), {'heal_fx', 'collect_fx', 'range_fx', 'burst_fx'})
        self.assertEqual(by_key['heal_fx']['on'], 'targets')
        self.assertTrue(all(by_key[k]['on'] == 'owner' for k in ('collect_fx', 'range_fx', 'burst_fx')))
        self.assertTrue(all(u['life'] == {'type': 'INFINITY', 'tick': 2} for u in uses))
        self.assertEqual(by_key['burst_fx']['event'], 'ON_BUFF_TRIGGER')
        self.assertTrue(all(u['node'] == 'Modes/S3/Body/AuraHeal' for u in uses))

    def test_no_guessed_effects_or_unrelated_ability_changes(self):
        fields = {'_buffs': [{'buffKey': 'unknown', 'templateKey': 'unknown'}]}
        self.assertEqual(mode_aura_uses('AuraAbility', fields, 'Aura'), [])
        self.assertEqual(mode_aura_uses('MeleeAttack', {'_buffs': [
            {'overrideEffectKey': 'actual_fx'}]}, 'Attack'), [])


if __name__ == '__main__':
    unittest.main()
