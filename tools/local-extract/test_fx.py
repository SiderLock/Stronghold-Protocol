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


class SkinFxPublishTests(unittest.TestCase):
    """`skinfx.py merge`: an index only publishes replacements it actually holds."""

    def test_dangling_replacements_are_dropped_and_reported(self):
        import json
        import tempfile
        from pathlib import Path
        from skinfx import merge

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'index.json'
            path.write_text(json.dumps({'prefabs': {'base_hit': {}, 'skin_hit': {}}, 'units': {}}), encoding='utf-8')
            skins = {
                'char_a@skin#1': {'replace': {'base_hit': 'skin_hit', 'base_buff': 'missing_buff'}},
                # nothing left to replace: the outfit keeps its base effects and leaves the section out
                'char_b@skin#2': {'replace': {'base_buff': 'missing_buff'}},
                # a fake projectile is kept even without replacements (reported, not exported)
                'char_c@skin#3': {'replace': {}, 'fakeProjectiles': [{'graphicProjectileKey': 'p_x'}]},
            }
            written, missing, dropped = merge(path, skins)
            index = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(written, 2)
            self.assertEqual(index['skinFx']['char_a@skin#1']['replace'], {'base_hit': 'skin_hit'})
            self.assertNotIn('char_b@skin#2', index['skinFx'])
            self.assertIn('char_c@skin#3', index['skinFx'])
            self.assertEqual(missing, ['missing_buff'])
            self.assertEqual(len(dropped), 2)
            for rec in index['skinFx'].values():
                for target in rec['replace'].values():
                    self.assertIn(target, index['prefabs'])


class AtomicWriteTests(unittest.TestCase):
    def test_identical_shared_file_needs_no_replacement(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from fx import write_atomic

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'shared.json'
            path.write_bytes(b'same')
            with patch('fx.os.replace') as replace:
                write_atomic(path, b'same')
            replace.assert_not_called()
            self.assertEqual(list(Path(tmp).iterdir()), [path])

    def test_transient_windows_lock_retries_and_keeps_atomic_replace(self):
        import os
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from fx import write_atomic

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'shared.json'
            path.write_bytes(b'old')
            locked = PermissionError('shared mesh is busy')
            locked.winerror = 5
            original_replace = os.replace
            calls = []

            def replace(source, target):
                calls.append(source)
                if len(calls) == 1:
                    raise locked
                return original_replace(source, target)

            with patch('fx.os.replace', side_effect=replace), patch('fx.time.sleep'):
                write_atomic(path, b'new')
            self.assertEqual(len(calls), 2)
            self.assertEqual(path.read_bytes(), b'new')
            self.assertEqual(list(Path(tmp).iterdir()), [path])

    def test_permanent_lock_and_unrelated_permission_error_preserve_previous_file(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from fx import write_atomic

        for code in (5, 13):
            with self.subTest(winerror=code), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'shared.json'
                path.write_bytes(b'old')
                error = PermissionError('cannot replace')
                error.winerror = code
                with patch('fx.os.replace', side_effect=error), patch('fx.time.monotonic', side_effect=[0, 2]):
                    with self.assertRaises(PermissionError):
                        write_atomic(path, b'new')
                self.assertEqual(path.read_bytes(), b'old')
                self.assertEqual(list(Path(tmp).iterdir()), [path])


if __name__ == '__main__':
    unittest.main()
